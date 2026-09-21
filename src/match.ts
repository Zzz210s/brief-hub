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
	return { items, suppressed, matchedIds, estimatedTokens: spend };
}

/** 渲染一级投递(标题批摘要):每条约 15-20 token,含一行建议命令 */
export function renderDigest(plan: DeliveryPlan): string {
	if (plan.items.length === 0) return "";
	const lines = plan.items.map((item) => {
		const brief = item.brief;
		const merged = item.mergedFrom && item.mergedFrom.length > 1 ? `(+${item.mergedFrom.length - 1})` : "";
		return `- [${brief.severity === "err" ? "!" : brief.kind}] ${brief.title}${merged}  (${brief.id})`;
	});
	const tail = plan.suppressed > 0 ? `\n另有 ${plan.suppressed} 条低优先简报未展开(bh list --unread)` : "";
	return `简报集散地:${plan.items.length} 条相关\n${lines.join("\n")}${tail}\n读某条: bh read <id>`;
}

/** 渲染二级投递(单条正文) */
export function renderBrief(brief: Brief): string {
	const facts = (brief.facts ?? []).map((fact) => `  - ${fact}`).join("\n");
	const artifacts = (brief.artifacts ?? []).map((item) => `  工件: ${item.ref}`).join("\n");
	const action = brief.action ? `\n建议动作: ${brief.action}` : "";
	return `[${brief.kind}] ${brief.title}  (${brief.id})\n  来源: ${brief.src.tool} / ${brief.src.name} @ ${brief.src.cwd}\n  标签: ${brief.tags.join(" ")}\n${facts}${artifacts ? "\n" + artifacts : ""}${action}`;
}
