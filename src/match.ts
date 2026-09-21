/**
 * 投递计划(纯函数):从"新到的简报 + 订阅 + 状态"算出"这一轮该注入什么"。
 *
 * 省 token 的关键都在这里:
 *   1) 标签硬过滤(0 token,集合运算)
 *   2) 打分门限(0 token,算术)
 *   3) 同去重键合并(把 20 条同类事件并成 1 条)
 *   4) 每小时 token 预算:超预算的按分数排队,只给一行"另有 N 条未展开"
 *   5) 已读剔除:consumed 里的永不重复投递
 *   6) 无命中时返回空计划 -> 调用方一次上下文注入都不发生
 */

import { DEFAULTS, type Brief, type Subscription, type SubState } from "./schema.ts";
import { scoreBrief, tagsIntersect } from "./tags.ts";

export interface PlanInput {
	/** 游标之后的新简报(已按时间升序) */
	incoming: Brief[];
	sub: Subscription;
	state: SubState;
	now: number;
	/** 全局合并窗口覆盖 */
	coalesceMs?: number;
	/** 预算覆盖(测试用) */
	budgetPerHour?: number;
	/**
	 * 命中该批简报的订阅数(来自 fanout 索引)。用于 auto 模式判断拥挤度:
	 * 拥挤则改为按小时合并,避免"一条推送打扰 N 个会话"。
	 */
	fanout?: number;
	/** 拥挤度阈值覆盖(测试用) */
	fanoutBatchK?: number;
	/** 合并间隔覆盖(测试用) */
	batchWindowMs?: number;
}

export interface PlannedItem {
	brief: Brief;
	score: number;
	/** 由多条简报合并而来时的成员 id */
	mergedFrom?: string[];
}

export interface DeliveryPlan {
	/** 本轮要投递的条目(按分数降序) */
	items: PlannedItem[];
	/** 因预算被压下的条数(摘要里给一行提示) */
	suppressed: number;
	/** 本轮所有被命中条目的 id(含被预算压下的),用于写 unread */
	matchedIds: string[];
	/** 计划注入的估算 token(0 表示无需注入) */
	estimatedTokens: number;
	/** 无命中时的原因(便于 doctor 诊断) */
	reason?: string;
}

/** 估算一条简报标题的注入成本(token) */
export function estimateTokens(brief: Brief): number {
	const text = `[${brief.kind}] ${brief.title}`;
	return Math.ceil(text.length * DEFAULTS.tokensPerChar) + DEFAULTS.perBriefOverheadTokens;
}

/** 是否处于静默时段(支持跨零点,如 [23, 7)) */
export function inQuietHours(hour: number, quiet?: [number, number]): boolean {
	if (!quiet) return false;
	const [from, to] = quiet;
	if (from === to) return false;
	return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** 同去重键合并:保留最新时间与合并后的事实,记录成员 id */
function coalesce(items: PlannedItem[], windowMs: number): PlannedItem[] {
	const groups = new Map<string, PlannedItem>();
	const order: string[] = [];
	for (const item of items) {
		const key = item.brief.key || item.brief.id;
		const existing = groups.get(key);
		if (!existing || item.brief.ts - existing.brief.ts > windowMs) {
			if (!existing) order.push(key);
			groups.set(key, item);
			continue;
		}
		const mergedFrom = [...(existing.mergedFrom ?? [existing.brief.id]), item.brief.id];
		groups.set(key, {
			brief: { ...item.brief, facts: dedupeFacts([...item.brief.facts, ...existing.brief.facts]).slice(0, 3) },
			score: Math.max(existing.score, item.score),
			mergedFrom,
		});
	}
	return order.map((key) => groups.get(key)!).filter(Boolean);
}

function dedupeFacts(facts: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const fact of facts) {
		const key = fact.trim().toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(fact);
	}
	return out;
}

/** 该订阅这一轮应当采用的投递节奏 */
export function resolveMode(input: { sub: Subscription; now: number; state: SubState; fanout?: number; fanoutBatchK?: number; batchWindowMs?: number }): "immediate" | "hourly" | "daily" {
	const declared = input.sub.mode ?? "auto";
	if (declared !== "auto") return declared;
	const k = input.fanoutBatchK ?? DEFAULTS.fanoutBatchK;
	return (input.fanout ?? 0) >= k ? "hourly" : "immediate";
}

/** 合并模式下的本轮投递间隔是否已到(未到则本轮不注入任何内容) */
export function batchDue(input: { mode: "immediate" | "hourly" | "daily"; state: SubState; now: number; batchWindowMs?: number }): boolean {
	if (input.mode === "immediate") return true;
	const windowMs = input.mode === "daily" ? 24 * 3_600_000 : (input.batchWindowMs ?? DEFAULTS.batchWindowMs);
	const last = input.state.lastDeliveryAt ?? 0;
	return input.now - last >= windowMs;
}

export function planDelivery(input: PlanInput): DeliveryPlan {
	const { sub, state, now } = input;
	if ((sub.delivery ?? "l1") === "off") {
		return { items: [], suppressed: 0, matchedIds: [], estimatedTokens: 0, reason: "订阅已关闭" };
	}
	if (inQuietHours(new Date(now).getHours(), sub.quietHours)) {
		return { items: [], suppressed: 0, matchedIds: [], estimatedTokens: 0, reason: "静默时段" };
	}

	const consumed = new Set(state.consumed ?? []);
	const threshold = sub.minScore ?? DEFAULTS.minScore;

	// 1) 硬过滤 + 已读剔除 + 打分:全部零 token
	const candidates: PlannedItem[] = [];
	for (const brief of input.incoming) {
		if (consumed.has(brief.id)) continue;
		if (now - brief.ts > brief.ttl * 1000) continue; // 过期
		if (!tagsIntersect(sub.tags ?? [], brief.tags ?? [])) continue;
		const score = scoreBrief(sub, brief, { now, repos: sub.repos, cwds: sub.cwds });
		if (score < threshold) continue;
		candidates.push({ brief, score });
	}
	if (candidates.length === 0) {
		return { items: [], suppressed: 0, matchedIds: [], estimatedTokens: 0, reason: "无命中" };
	}

	// 1.5) 投递节奏:拥挤/声明为 hourly|daily 时,一轮合并一次;未到点则不注入任何内容
	//      (条目保留为未读,不会丢;错误类与直接点名(sess:)始终立即)
	const mode = resolveMode({ sub, now, state, fanout: input.fanout, fanoutBatchK: input.fanoutBatchK, batchWindowMs: input.batchWindowMs });
	const matchedIdsAll = candidates.map((item) => item.brief.id).sort();
	const urgent = candidates.filter((item) => item.brief.severity === "err" || item.brief.tags.some((tag) => tag === `sess:${sub.sess}`));
	const routine = candidates.filter((item) => !urgent.includes(item));
	if (mode !== "immediate" && routine.length > 0 && !batchDue({ mode, state, now, batchWindowMs: input.batchWindowMs })) {
		if (urgent.length === 0) {
			return { items: [], suppressed: routine.length, matchedIds: matchedIdsAll, estimatedTokens: 0, reason: `合并投递未到点(${mode}),保留 ${routine.length} 条为未读` };
		}
		// 有紧急项:只投紧急项
		const urgentItems = coalesce(urgent, input.coalesceMs ?? DEFAULTS.coalesceMs);
		urgentItems.sort((a, b) => b.score - a.score || b.brief.ts - a.brief.ts);
		return { items: urgentItems, suppressed: routine.length, matchedIds: matchedIdsAll, estimatedTokens: urgentItems.reduce((sum, item) => sum + estimateTokens(item.brief), 0), reason: "仅紧急项立即投递" };
	}

	// 2) 合并 + 排序
	const coalesced = coalesce(candidates, input.coalesceMs ?? DEFAULTS.coalesceMs);
	const matchedIds = candidates.map((item) => item.brief.id).sort();
	coalesced.sort((a, b) => b.score - a.score || b.brief.ts - a.brief.ts);

	// 3) 预算:每小时上限,超出部分只计数
	const budget = input.budgetPerHour ?? sub.budgetPerHour ?? DEFAULTS.budgetPerHour;
	const hourStart = Math.floor(now / 3_600_000) * 3_600_000;
	const used = state.budget && state.budget.hourStart === hourStart ? state.budget.used : 0;
	const available = Math.max(0, budget - used);

	const items: PlannedItem[] = [];
	let spend = 0;
	for (const item of coalesced) {
		const cost = estimateTokens(item.brief) + (items.length > 0 ? 0 : 0);
		if (spend + cost > available) continue;
		items.push(item);
		spend += cost;
	}
	const suppressed = coalesced.length - items.length;
	if (items.length === 0) {
		return { items: [], suppressed, matchedIds, estimatedTokens: 0, reason: `预算已用尽(${used}/${budget})` };
	}
	// 注入成本按**实际渲染出的摘要**估算(合并模式下只展开前 N 条),而非逐条相加
	const rendered = renderDigest({ items, suppressed: suppressed, matchedIds, estimatedTokens: 0 });
	const renderedTokens = Math.ceil(rendered.length * DEFAULTS.tokensPerChar);
	return { items, suppressed, matchedIds, estimatedTokens: renderedTokens };
}

/** 渲染一级投递(标题批摘要):默认只展开前 N 条,其余只给计数 */
export function renderDigest(plan: DeliveryPlan, topN = DEFAULTS.batchTopN): string {
	if (plan.items.length === 0) return "";
	const shown = plan.items.slice(0, Math.max(1, topN));
	const lines = shown.map((item) => {
		const brief = item.brief;
		const merged = item.mergedFrom && item.mergedFrom.length > 1 ? `(+${item.mergedFrom.length - 1})` : "";
		return `- [${brief.severity === "err" ? "!" : brief.kind}] ${brief.title}${merged}  (${brief.id})`;
	});
	const hiddenInPlan = plan.items.length - shown.length;
	const hidden = hiddenInPlan + plan.suppressed;
	const tail = hidden > 0 ? `\n另有 ${hidden} 条未展开(bh list --unread)` : "";
	const head = hiddenInPlan > 0 || plan.suppressed > 0 ? `简报集散地:${plan.items.length + plan.suppressed} 条相关(展开 ${shown.length})` : `简报集散地:${plan.items.length} 条相关`;
	return `${head}\n${lines.join("\n")}${tail}\n读某条: bh read <id>`;
}

/** 渲染二级投递(单条正文) */
export function renderBrief(brief: Brief): string {
	const facts = (brief.facts ?? []).map((fact) => `  - ${fact}`).join("\n");
	const artifacts = (brief.artifacts ?? []).map((item) => `  工件: ${item.ref}`).join("\n");
	const action = brief.action ? `\n建议动作: ${brief.action}` : "";
	return `[${brief.kind}] ${brief.title}  (${brief.id})\n  来源: ${brief.src.tool} / ${brief.src.name} @ ${brief.src.cwd}\n  标签: ${brief.tags.join(" ")}\n${facts}${artifacts ? "\n" + artifacts : ""}${action}`;
}
