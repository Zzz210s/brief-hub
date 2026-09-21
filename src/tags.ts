/**
 * 标签:推导、层级展开与匹配打分(全部纯函数,零 token)
 *
 * 这是"省 token"的第一道闸门:是否值得进上下文,完全由这里的集合运算与算术决定,
 * 不调用任何模型。
 */

import type { Brief, Subscription } from "./schema.ts";

/** 标签的父级链:git.push -> [git.push, git];repo:a/b -> [repo:a/b, repo:a/b? 否 -> repo:a/*, repo] */
export function tagChain(tag: string): string[] {
	const out = [tag];
	const colon = tag.indexOf(":");
	if (colon > 0) {
		const ns = tag.slice(0, colon);
		const value = tag.slice(colon + 1);
		// repo:owner/name -> repo:owner/* -> repo
		const slash = value.indexOf("/");
		if (slash > 0) out.push(`${ns}:${value.slice(0, slash)}/*`);
		out.push(ns);
		return out;
	}
	const dot = tag.indexOf(".");
	if (dot > 0) out.push(tag.slice(0, dot));
	return out;
}

/** 命中的标签及其层级权重(精确 2.0,父级 1.0) */
export function tagHits(subTags: string[], briefTags: string[]): { tag: string; weight: number }[] {
	const wanted = new Set(subTags);
	/** 同一订阅标签只计一次(取最高权重):否则 git + git.push 会被重复加分 */
	const best = new Map<string, number>();
	for (const tag of briefTags) {
		const chain = tagChain(tag);
		for (let i = 0; i < chain.length; i++) {
			if (!wanted.has(chain[i])) continue;
			const weight = i === 0 ? 2 : 1;
			best.set(chain[i], Math.max(best.get(chain[i]) ?? 0, weight));
			break;
		}
	}
	return [...best.entries()].map(([tag, weight]) => ({ tag, weight }));
}

/** 硬过滤:标签集合是否有交集(先做集合运算,再算分,尽早短路) */
export function tagsIntersect(subTags: string[], briefTags: string[]): boolean {
	if (subTags.length === 0) return false;
	const wanted = new Set(subTags);
	for (const tag of briefTags) {
		for (const candidate of tagChain(tag)) {
			if (wanted.has(candidate)) return true;
		}
	}
	return false;
}

export interface ScoreContext {
	/** 当前时间(毫秒) */
	now: number;
	/** 亲和的仓库名单(订阅里声明) */
	repos?: string[];
	/** 亲和的目录前缀 */
	cwds?: string[];
}

/**
 * 相关度打分(纯算术):
 *   精确标签 +2.0 / 父级标签 +1.0
 *   同仓库 +0.5,同目录前缀 +0.5
 *   严重度 sev:err +0.5
 *   陈旧衰减:每 12 小时 -0.5(24 小时 -1.0,最多扣 1.0)
 */
export function scoreBrief(sub: Subscription, brief: Brief, ctx: ScoreContext): number {
	const hits = tagHits(sub.tags ?? [], brief.tags ?? []);
	if (hits.length === 0) return 0;
	let score = hits.reduce((sum, hit) => sum + hit.weight, 0);

	const repos = sub.repos ?? [];
	if (repos.length && brief.tags.some((tag) => repos.some((repo) => tag === `repo:${repo}`))) score += 0.5;

	const cwds = sub.cwds ?? [];
	if (cwds.length && cwds.some((prefix) => brief.src.cwd?.toLowerCase().startsWith(prefix.toLowerCase()))) score += 0.5;

	if (brief.severity === "err" || brief.tags.includes("sev:err")) score += 0.5;

	const ageHours = Math.max(0, (ctx.now - brief.ts) / 3_600_000);
	score -= Math.min(1, (ageHours / 12) * 0.5);
	return Math.round(score * 100) / 100;
}

/** 从会话快照推导标签(自动推导,手动订阅可覆盖) */
export interface TagSource {
	tool: string;
	sessionName: string;
	cwd: string;
	/** 归属仓库(owner/name),由调用方探测(可能要读 .git/config) */
	repo?: string;
	/** 本次会话改动的文件路径 */
	changedPaths?: string[];
	/** 本次会话执行过的命令 */
	commands?: string[];
	severity?: "err" | "warn" | "info";
	kind?: string;
}

const CONFIG_HINTS = ["config-ai", ".pi/agent", "config-cli", "settings.json", "settings.jsonc", "config.toml", "AGENTS.md"];
const RULE_TABLE: { match: RegExp; tags: string[] }[] = [
	{ match: /\bgit\s+push\b/, tags: ["git", "git.push"] },
	{ match: /\bgit\s+commit\b/, tags: ["git", "git.commit"] },
	{ match: /\bgit\s+(merge|rebase|checkout|switch)\b/, tags: ["git"] },
	{ match: /\b(gh|github)\b/, tags: ["github"] },
	{ match: /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b/, tags: ["deps"] },
	{ match: /\b(pi|claude|opencode)\b.*\b(config|settings|extensions?)\b/, tags: ["pi.config"] },
	{ match: /\b(systeminfo|powercfg|services?|registry|reg\s+add)\b/, tags: ["system"] },
	{ match: /\bdocker\b/, tags: ["docker"] },
];

/** 会话名关键词(兜底,权重与推导相同 —— 手动订阅仍可覆盖) */
const NAME_HINTS: { match: RegExp; tags: string[] }[] = [
	{ match: /github|git\b/i, tags: ["git"] },
	{ match: /电脑|系统|优化|性能|performance|system/i, tags: ["system"] },
	{ match: /配置|config/i, tags: ["config"] },
	{ match: /代码|code|refactor/i, tags: ["code"] },
];

export function deriveTags(source: TagSource): string[] {
	const tags = new Set<string>();
	tags.add(`tool:${source.tool}`);
	if (source.sessionName) tags.add(`sess:${source.sessionName}`);
	tags.add(`sev:${source.severity ?? "info"}`);
	if (source.kind) tags.add(source.kind);

	if (source.cwd) {
		const normalized = source.cwd.replace(/\\/g, "/").toLowerCase();
		// 项目目录名:最后一段
		const base = normalized.split("/").filter(Boolean).pop();
		if (base) tags.add(`proj:${base}`);
	}
	if (source.repo) tags.add(`repo:${source.repo}`);

	for (const path of source.changedPaths ?? []) {
		const normalized = path.replace(/\\/g, "/").toLowerCase();
		if (CONFIG_HINTS.some((hint) => normalized.includes(hint))) tags.add("config");
		if (/(^|\/)package\.json$|\/node_modules\//.test(normalized)) tags.add("deps");
		if (/(^|\/)\.github\//.test(normalized)) tags.add("github");
		if (/(^|\/)\.pi\/agent\//.test(normalized)) tags.add("pi.config");
	}
	for (const command of source.commands ?? []) {
		for (const rule of RULE_TABLE) {
			if (rule.match.test(command)) rule.tags.forEach((tag) => tags.add(tag));
		}
	}
	for (const hint of NAME_HINTS) {
		if (hint.match.test(source.sessionName ?? "")) hint.tags.forEach((tag) => tags.add(tag));
	}
	return [...tags].sort();
}
