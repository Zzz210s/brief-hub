/**
 * 消费者一次轮询的完整流程(io 层,pi 扩展与 CLI 共用)。
 *
 * 省 token 的三条硬规则都体现在这里:
 *   1) 首次运行只对齐游标、不投递历史(避免一次灌进几百条)
 *   2) 无命中时不产生任何可供注入的文本(digest 为空串)
 *   3) 只有真正投递出去的条目才写"已读";被预算压下的留作未读,下轮继续
 */

import { DEFAULTS, type SubState, type Subscription } from "./schema.ts";
import { listBriefFiles, markConsumed, readAfter, readConfig, readFanoutIndex, readState, readSubscription, todayFile, writeState } from "./store.ts";
import { planDelivery, renderDigest, type DeliveryPlan } from "./match.ts";
import { classify, renderProtocol, shouldSurface, type PendingItem } from "./handling.ts";
import { maxFanoutFor } from "./store.ts";
import { readShards } from "./shards.ts";

export interface PollOptions {
	now?: number;
	/** 首次运行也投递历史(默认 false:只对齐游标) */
	includeHistory?: boolean;
	/** 强制忽略静默时段 */
	force?: boolean;
	/**
	 * 只窥视(不消费):算出本轮会投递什么,但**不推进游标、不标已读、不扣预算**。
	 * 用于“状态徽标/待读计数”这类展示路径 —— 避免“看板把简报送吃了、模型从未见过”。
	 */
	peek?: boolean;
}

export interface PollResult {
	sess: string;
	reason?: string;
	plan?: DeliveryPlan;
	digest: string;
	scanned: number;
	delivered: number;
	state: SubState;
	/** 实际读取字节(衡量 IO 开销) */
	bytesRead?: number;
	/** 因未变化而跳过的分片数(零 IO) */
	skippedShards?: number;
}

export async function pollOnce(sess: string, options: PollOptions = {}): Promise<PollResult> {
	const now = options.now ?? Date.now();
	const sub: Subscription | undefined = await readSubscription(sess);
	const state = await readState(sess);
	if (!sub) return { sess, reason: "无订阅(先 bh sub add <标签>)", digest: "", scanned: 0, delivered: 0, state };
	const config = await readConfig();
	const files = await listBriefFiles(3);
	const cursors: Record<string, number> = state.cursors ?? {};
	const firstRun = !state.alignedAt && !options.includeHistory; // 显式标记,避免集散地为空时反复"首次对齐"

	// 读共享分片(一条简报按标签链写入,同一标签的所有订阅者读**同一份**文件);
	// mtime/size 未变化的分片本轮完全不读(零 IO)。
	const shardTags = [...new Set((sub.tags ?? []).filter((tag) => !tag.includes("*")))];
	const shardRead = shardTags.length ? await readShards(shardTags, cursors, state.seen ?? {}) : { briefs: [], cursors, skipped: 0, bytesRead: 0, seen: {} };
	const incoming: Brief[] = [...shardRead.briefs];
	let scanned = shardRead.briefs.length;
	let bytesRead = shardRead.bytesRead;
	const nextCursors: Record<string, number> = { ...shardRead.cursors };
	for (const file of files) {
		if (firstRun) {
			const aligned = await readAfter(file, 0);
			nextCursors[file] = aligned.offset;
			continue;
		}
		// 分片已覆盖常规投递路径;归档仅用于补投/回放(此处不再扫)
		if (shardTags.length) continue;
		const tail = await readAfter(file, cursors[file] ?? 0);
		nextCursors[file] = tail.offset;
		if (tail.briefs.length) {
			incoming.push(...tail.briefs);
			scanned += tail.briefs.length;
		}
	}
	// 只保留归档文件与分片文件的游标(避免无限增长);
	// 注意:分片游标必须保留 —— 否则每轮都从头重读,IO 会随简报数线性上涨。
	const keep = new Set([...files, ...Object.keys(shardRead.seen)]);
	const trimmedCursors = Object.fromEntries(Object.entries(nextCursors).filter(([file]) => keep.has(file)));

	if (firstRun) {
		const next = await writeState(sess, { ...state, cursors: trimmedCursors, seen: shardRead.seen, alignedAt: now });
		return { sess, reason: "首次运行:已对齐游标(不投递历史)", digest: "", scanned: 0, delivered: 0, state: next };
	}

	// 候选过滤(实测两个浪费来源):
	//   1) 自简报 —— 会话自己刚投的,它已经知道,再读一遍纯属浪费
	//   2) 已处理/已延迟/已投递过 —— 不再浮现
	const candidates = incoming.filter((brief) => brief.src?.sess !== sess && shouldSurface(brief, state, now));
	const fanoutIndex = await readFanoutIndex();
	const fanout = maxFanoutFor([...new Set(candidates.flatMap((brief) => brief.tags ?? []))], fanoutIndex);
	const plan = planDelivery({
		incoming: candidates.sort((a, b) => a.ts - b.ts),
		sub: options.force && sub.quietHours ? { ...sub, quietHours: undefined } : sub,
		state,
		now,
		fanout,
		coalesceMs: config.coalesceMs ?? DEFAULTS.coalesceMs,
	});
	const pendingItems: PendingItem[] = plan.items.map((item) => ({
		brief: item.brief,
		action: classify(item.brief, sub),
		resurfaced: Boolean(state.deferred?.[item.brief.id]),
	}));
	const digest = pendingItems.length
		? (renderProtocol(pendingItems, { compact: Boolean(state.protocolSent) }) ?? renderDigest(plan))
		: "";

	// 只有投递出去的才标已读;被预算压下的留在 unread 供后续展开
	const deliveredIds = plan.items.flatMap((item) => [item.brief.id, ...(item.mergedFrom ?? [])]);

	// peek:只报告本轮会投递什么,不改变任何持久状态(游标/已读/预算全不动)
	if (options.peek) {
		return { sess, plan, digest, scanned, delivered: plan.items.length, state, reason: plan.reason, bytesRead, skippedShards: shardRead.skipped };
	}
	const newlyUnread = [...new Set([...(state.unread ?? []), ...deliveredIds, ...plan.matchedIds.filter((id) => !deliveredIds.includes(id))])];
	let next: SubState = {
		...state,
		alignedAt: state.alignedAt ?? now,
		protocolSent: state.protocolSent || pendingItems.length > 0,
		cursors: trimmedCursors,
		seen: shardRead.seen,
		unread: newlyUnread.slice(0, 200),
		lastDeliveryAt: plan.items.length ? now : state.lastDeliveryAt,
	};
	if (plan.items.length) next = markConsumed(next, deliveredIds, now);
	const hourStart = Math.floor(now / 3_600_000) * 3_600_000;
	if (plan.estimatedTokens > 0) {
		const used = state.budget?.hourStart === hourStart ? state.budget.used : 0;
		next.budget = { hourStart, used: used + plan.estimatedTokens };
	}
	const saved = await writeState(sess, next);
	return { sess, plan, digest, scanned, delivered: plan.items.length, state: saved, reason: plan.reason, bytesRead, skippedShards: shardRead.skipped };
}

/** 生成一个默认订阅(自动推导的兜底:订阅常见领域标签,但不含任何"自动注入") */
export function defaultSub(sess: string, tags: string[]): Subscription {
	return { sess, tags, minScore: DEFAULTS.minScore, budgetPerHour: DEFAULTS.budgetPerHour, delivery: "l1" };
}

/** 便于 CLI:仅对齐游标(不投递) */
export async function alignCursor(sess: string): Promise<void> {
	const files = await listBriefFiles(3);
	const state = await readState(sess);
	const cursors: Record<string, number> = { ...(state.cursors ?? {}) };
	for (const file of files) {
		const tail = await readAfter(file, 0);
		cursors[file] = tail.offset;
	}
	cursors[todayFile()] = cursors[todayFile()] ?? 0;
	await writeState(sess, { ...state, cursors });
}
