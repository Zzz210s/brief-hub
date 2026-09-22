/**
 * 接收端处理协议(纯函数):简报到了之后,会话该按什么步骤、什么优先级处理。
 *
 * 为什么需要:扩展无法主动唤醒空闲会话,所以"收到简报"只能发生在会话**下一轮开工**
 * 的时刻。因此接收端必须有一套明确、可执行、可追踪的处理方法 —— 否则简报就只是
 * 一段"看起来像背景信息"的文本,模型读完就忘。
 *
 * 三类动作:
 *   act   必须处理(错误 / 直接点名本会话 / 建议动作指向本机现状)
 *   check 需要核对(与本职相关:同仓库、同目录、订阅标签精确命中)
 *   fyi   仅供参考(父级标签命中、陈旧条目)
 */

import type { Brief, Subscription, SubState } from "./schema.ts";

export type ActionClass = "act" | "check" | "fyi";

/** 处理状态:id -> 时间戳 */
export interface HandlingState {
	handled?: Record<string, number>;
	deferred?: Record<string, number>;
}

/** 延迟多久后重新浮出(毫秒) */
export const DEFER_RESURFACE_MS = 4 * 3_600_000;

export function classify(brief: Brief, sub: Subscription): ActionClass {
	const tags = brief.tags ?? [];
	if (brief.severity === "err") return "act";
	if (tags.includes(`sess:${sub.sess}`) || tags.includes(`sess:${sub.sess.slice(0, 8)}`)) return "act";
	if (brief.action) return "act";
	const repos = sub.repos ?? [];
	if (repos.some((repo) => tags.includes(`repo:${repo}`))) return "check";
	const exact = (sub.tags ?? []).some((tag) => tags.includes(tag));
	if (exact) return "check";
	return "fyi";
}

/** 是否该在本次浮现:未处理 && (未延迟 || 延迟已到) */
export function shouldSurface(brief: Brief, state: SubState & HandlingState, now: number, resurfaceMs = DEFER_RESURFACE_MS): boolean {
	if (state.handled?.[brief.id]) return false;
	if (state.consumed?.includes(brief.id)) return false; // 已投递过的不重复(分片重写后游标可能回退)
	const deferredAt = state.deferred?.[brief.id];
	if (deferredAt && now - deferredAt < resurfaceMs) return false;
	return true;
}

export interface PendingItem {
	brief: Brief;
	action: ActionClass;
	/** 因延迟而重新浮出 */
	resurfaced?: boolean;
}

/** 按动作类分组(act 在前),每类内按时间倒序 */
export function groupPending(items: PendingItem[]): Record<ActionClass, PendingItem[]> {
	const out: Record<ActionClass, PendingItem[]> = { act: [], check: [], fyi: [] };
	for (const item of items.slice().sort((a, b) => b.brief.ts - a.brief.ts)) out[item.action].push(item);
	return out;
}

const LABEL: Record<ActionClass, string> = {
	act: "必须处理",
	check: "需要核对",
	fyi: "仅供参考",
};

/**
 * 生成注入文本:协议步骤 + 按优先级分组的简报清单。
 * 无待处理条目时返回 undefined(调用方完全不注入,0 token)。
 */
export function renderProtocol(items: PendingItem[], options: { maxPerClass?: number } = {}): string | undefined {
	if (items.length === 0) return undefined;
	const max = options.maxPerClass ?? 3;
	const groups = groupPending(items);
	const lines: string[] = [];
	lines.push("【简报集散地 brief-hub · 待你处理】以下简报与你的订阅相关。");
	lines.push("不要只回复编号或“收到” —— 要么执行,要么延后。处理方式:");
	lines.push("1) 逐条判断是否属于你的职责(看标签/仓库/项目);2) 相关的用 `bh read <id>` 读全文;");
	lines.push("3) 按简报的「建议动作」执行,或把它纳入当前计划;4) 处理完 `bh handle <id> --note \"结论\"`;");
	lines.push("5) 已知晓但暂不处理:`bh defer <id>`(4 小时后重新提醒)。错误类简报必须处理。");
	lines.push("若你正在执行用户当前请求:先完成它,再回来处理这些简报(或先 defer 记下)。");
	for (const action of ["act", "check", "fyi"] as ActionClass[]) {
		const bucket = groups[action];
		if (bucket.length === 0) continue;
		lines.push(`${LABEL[action]}(${bucket.length}):`);
		for (const item of bucket.slice(0, max)) {
			const resurfaced = item.resurfaced ? " [再次提醒]" : "";
			lines.push(`  - [${item.brief.kind}] ${item.brief.title}  (${item.brief.id})${resurfaced}`);
		}
		if (bucket.length > max) lines.push(`  … 另有 ${bucket.length - max} 条同优先级,见 bh pending --sess=<本会话>`);
	}
	return lines.join("\n");
}

/** 处理统计(供 doctor / status 展示) */
export function handlingStats(state: SubState & HandlingState, now: number): { handled: number; deferred: number; deferredDue: number } {
	const deferred = Object.entries(state.deferred ?? {});
	return {
		handled: Object.keys(state.handled ?? {}).length,
		deferred: deferred.length,
		deferredDue: deferred.filter(([, at]) => now - at >= DEFER_RESURFACE_MS).length,
	};
}
