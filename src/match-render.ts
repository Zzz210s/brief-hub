import { DEFAULTS, type Brief, type Subscription, type SubState } from "./schema.ts";
import { scoreBrief, tagsIntersect } from "./tags.ts";

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

/** 估算一条简报标题的注入成本(token) */
export function estimateTokens(brief: Brief): number {
	const text = `[${brief.kind}] ${brief.title}`;
	return Math.ceil(text.length * DEFAULTS.tokensPerChar) + DEFAULTS.perBriefOverheadTokens;
}

/** 是否处于静默时段(支持跨零点,如 [23, 7)) */
