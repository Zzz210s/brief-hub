/**
 * 消费者一次轮询的完整流程(io 层,pi 扩展与 CLI 共用)。
 *
 * 省 token 的三条硬规则都体现在这里:
 *   1) 首次运行只对齐游标、不投递历史(避免一次灌进几百条)
 *   2) 无命中时不产生任何可供注入的文本(digest 为空串)
 *   3) 只有真正投递出去的条目才写"已读";被预算压下的留作未读,下轮继续
 */

import { DEFAULTS, type SubState, type Subscription } from "./schema.ts";
import { listBriefFiles, markConsumed, readAfter, readConfig, readState, readSubscription, todayFile, writeState } from "./store.ts";
import { planDelivery, renderDigest, type DeliveryPlan } from "./match.ts";

export interface PollOptions {
	now?: number;
	/** 首次运行也投递历史(默认 false:只对齐游标) */
	includeHistory?: boolean;
	/** 强制忽略静默时段 */
	force?: boolean;
}

export interface PollResult {
	sess: string;
	reason?: string;
	plan?: DeliveryPlan;
	digest: string;
	scanned: number;
	delivered: number;
	state: SubState;
}

export async function pollOnce(sess: string, options: PollOptions = {}): Promise<PollResult> {
	const now = options.now ?? Date.now();
	const sub: Subscription | undefined = await readSubscription(sess);
	const state = await readState(sess);
	if (!sub) return { sess, reason: "无订阅(先 bh sub add <标签>)", digest: "", scanned: 0, delivered: 0, state };
	const config = await readConfig();
	const files = await listBriefFiles(3);
	const cursors: Record<string, number> = state.cursors ?? {};
	const firstRun = Object.keys(cursors).length === 0 && !options.includeHistory;

	const incoming = [];
	let scanned = 0;
	const nextCursors: Record<string, number> = { ...cursors };
	for (const file of files) {
		if (firstRun) {
			const aligned = await readAfter(file, 0);
			nextCursors[file] = aligned.offset;
			continue;
		}
		const tail = await readAfter(file, cursors[file] ?? 0);
		nextCursors[file] = tail.offset;
		scanned += tail.corrupt ? 0 : 0;
		if (tail.briefs.length) {
			incoming.push(...tail.briefs);
			scanned += tail.briefs.length;
		}
	}
	// 只保留最近 3 天的游标,避免无限增长
	const keep = new Set(files);
	const trimmedCursors = Object.fromEntries(Object.entries(nextCursors).filter(([file]) => keep.has(file)));

	if (firstRun) {
		const next = await writeState(sess, { ...state, cursors: trimmedCursors });
		return { sess, reason: "首次运行:已对齐游标(不投递历史)", digest: "", scanned: 0, delivered: 0, state: next };
	}

	const plan = planDelivery({
		incoming: incoming.sort((a, b) => a.ts - b.ts),
		sub: options.force && sub.quietHours ? { ...sub, quietHours: undefined } : sub,
		state,
		now,
		coalesceMs: config.coalesceMs ?? DEFAULTS.coalesceMs,
	});
	const digest = plan.items.length ? renderDigest(plan) : "";

	// 只有投递出去的才标已读;被预算压下的留在 unread 供后续展开
	const deliveredIds = plan.items.flatMap((item) => [item.brief.id, ...(item.mergedFrom ?? [])]);
	const newlyUnread = [...new Set([...(state.unread ?? []), ...deliveredIds, ...plan.matchedIds.filter((id) => !deliveredIds.includes(id))])];
	let next: SubState = {
		...state,
		cursors: trimmedCursors,
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
	return { sess, plan, digest, scanned, delivered: plan.items.length, state: saved, reason: plan.reason };
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
