/**
 * 历史简报清理(P4):按条件挑出要"清场"的简报。
 *
 * 语义说明:这里做的是**软清理** —— 把命中的简报在所有会话里标记为已处理,
 * 于是它们不再出现在任何人的待处理清单里,但归档与分片保持完整(仍可 grep、
 * 仍能 `bh read`)。不做硬删除的原因:分片是追加式且消费者按字节游标读取,
 * 重写分片会让游标错位,可能让别的会话漏读新简报。
 */

import type { Brief } from "./schema.ts";
import { errorClass } from "./errors.ts";

export interface PurgeFilter {
	/** 只清某类事件,如 task.error */
	kind?: string;
	/** 只清某个严重度:err / warn / info */
	severity?: string;
	/** 只清早于该时刻的简报(毫秒时间戳) */
	before?: number;
	/** 标题/要点里匹配该正则(字符串形式,便于从命令行传入) */
	pattern?: string;
	/** 只清被 errorClass 判为噪声的简报(一键清噪声backlog) */
	noiseOnly?: boolean;
	/** 只清某个会话投的简报 */
	fromSession?: string;
}

/** 单条简报是否命中清理条件(纯函数) */
export function matchesFilter(brief: Brief, filter: PurgeFilter): boolean {
	if (filter.kind && brief.kind !== filter.kind) return false;
	if (filter.severity && brief.severity !== filter.severity) return false;
	if (filter.before !== undefined && brief.ts >= filter.before) return false;
	if (filter.fromSession && brief.src?.sess !== filter.fromSession) return false;
	if (filter.noiseOnly) {
		const text = `${brief.title} ${(brief.facts ?? []).join(" ")}`;
		if (errorClass(text) !== "noise") return false;
	}
	if (filter.pattern) {
		let regex: RegExp;
		try {
			regex = new RegExp(filter.pattern);
		} catch {
			return false; // 非法正则:不匹配任何东西,避免误清
		}
		const haystack = `${brief.title} ${(brief.facts ?? []).join(" ")} ${(brief.tags ?? []).join(" ")}`;
		if (!regex.test(haystack)) return false;
	}
	return true;
}

/** 从简报集合里挑出命中的 id(纯函数,便于单测) */
export function selectForPurge(briefs: Brief[], filter: PurgeFilter): string[] {
	return briefs.filter((brief) => matchesFilter(brief, filter)).map((brief) => brief.id);
}

/** 把命令行参数解析成过滤器(纯函数) */
export function filterFromArgs(input: {
	kind?: string;
	severity?: string;
	before?: string;
	pattern?: string;
	noise?: boolean;
	sess?: string;
}): PurgeFilter {
	const before = input.before ? Date.parse(input.before) : undefined;
	return {
		kind: input.kind,
		severity: input.severity,
		before: Number.isFinite(before) ? before : undefined,
		pattern: input.pattern,
		noiseOnly: input.noise,
		fromSession: input.sess,
	};
}

/** 从 JSONL 文本里剔除指定 id 的行(纯函数,便于单测) */
export function stripBriefs(text: string, ids: string[]): { kept: string; removed: number } {
	const drop = new Set(ids);
	const lines = text.split("\n");
	const kept: string[] = [];
	let removed = 0;
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) {
			if (trimmed) kept.push(line);
			continue;
		}
		try {
			const brief = JSON.parse(trimmed) as Brief;
			if (drop.has(brief.id)) {
				removed++;
				continue;
			}
		} catch {
			/* 半行/坏行保留原样 */
		}
		kept.push(line);
	}
	return { kept: kept.join("\n"), removed };
}
