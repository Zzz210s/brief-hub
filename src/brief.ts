/**
 * 简报构建(纯函数):把"会话做了什么"压成一条有界简报。
 *
 * 省 token 的核心决定:**不调用模型做摘要**。标题与要点都从已有产物派生
 * (会话名、改动路径、执行过的命令、最终回复的截断),因此投稿成本为 0 额外 token。
 */

import { errorClass } from "./errors.ts";
import { DEFAULTS, type Brief, type Kind, type Severity } from "./schema.ts";
import { deriveTags } from "./tags.ts";

export interface SessionSnapshot {
	/** 会话 id(短) */
	sessionId: string;
	tool: string;
	sessionName: string;
	cwd: string;
	repo?: string;
	/** 任务耗时(毫秒) */
	durationMs?: number;
	/** 本次会话改动/新建的文件 */
	changedPaths: string[];
	/** 执行过的命令(可含结果标记) */
	commands: string[];
	/** 最终回复(用于兜底标题/要点) */
	finalMessage?: string;
	/** 错误文本(出错时) */
	errorText?: string;
	/** 是否发生 git 提交/推送(由调用方探测) */
	git?: { committed?: boolean; pushed?: boolean; summary?: string };
	/** 序号(同一会话内递增) */
	seq?: number;
}

const MAX_TITLE = 60;
const MAX_FACT = 48;

/** 截断到显示宽度上限(按字符数近似,CJK 亦按 1 计) */
export function clamp(text: string, limit: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= limit) return normalized;
	return normalized.slice(0, Math.max(1, limit - 1)) + "…";
}

function uniqueShort(paths: string[], limit = 3): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const path of paths) {
		const normalized = path.replace(/\\/g, "/");
		const parts = normalized.split("/").filter(Boolean);
		const short = parts.slice(-2).join("/");
		if (!short || seen.has(short)) continue;
		seen.add(short);
		out.push(short);
		if (out.length >= limit) break;
	}
	return out;
}

/** 生成去重键:同会话同类事件在合并窗口内视为一条 */
export function dedupeKey(snapshot: SessionSnapshot, kind: Kind, windowMs = DEFAULTS.coalesceMs): string {
	const bucket = Math.floor(Date.now() / windowMs);
	const anchor = snapshot.git?.summary ?? uniqueShort(snapshot.changedPaths, 1)[0] ?? kind;
	return `${snapshot.sessionId}|${kind}|${anchor}|${bucket}`;
}

export function makeId(now = new Date(), random: () => number = Math.random): string {
	const date = now.toISOString().slice(0, 10).replace(/-/g, "");
	const hex = Math.floor(random() * 0xffff)
		.toString(16)
		.padStart(4, "0");
	return `b-${date}-${hex}`;
}

/** 从会话快照构建简报(纯函数,可单测) */
/** 是否值得投一条简报(纯函数):没有改动/命令/错误/标题时不投 */
export function shouldPublish(snapshot: SessionSnapshot & { title?: string }): boolean {
	if (snapshot.title) return true;
	if (snapshot.changedPaths?.length) return true;
	if (snapshot.commands?.length) return true;
	const klass = snapshot.errorText ? errorClass(snapshot.errorText) : "none";
	return klass === "task" || klass === "tool";
}

/** 改动路径的最长公共目录(去掉末段文件名)——即"被改动的那个文件夹" */
export function changeScope(paths: string[]): string | undefined {
	if (!paths?.length) return undefined;
	const segs = paths.map((p) => p.replace(/\\/g, "/").split("/").filter(Boolean));
	const common: string[] = [];
	for (let i = 0; ; i++) {
		const head = segs[0][i];
		if (!head || !segs.every((seg) => seg[i] === head)) break;
		common.push(head);
	}
	if (common.length === 0) return undefined;
	return common.length > 1 ? common.slice(0, -1).join("/") : common[0];
}

export function buildBrief(snapshot: SessionSnapshot, options: { now?: number; id?: string } = {}): Brief {
	const now = options.now ?? Date.now();
	// 噪声过滤放在核心层:pi 扩展 / Claude hook / Codex notify / opencode 插件 / bh publish
	// 全都经过这里,不必各自实现一遍(实测过适配器漏过滤会导致噪声广播)
	const klass = snapshot.errorText ? errorClass(snapshot.errorText) : "none";
	const dropped = klass === "noise";
	const warnOnly = klass === "tool";
	const effectiveError = dropped ? undefined : snapshot.errorText;
	const failed = Boolean(effectiveError);
	const scope = changeScope(snapshot.changedPaths ?? []);
	// 只投一种简报:变更简报(触发条件=某个文件夹被改动,见投稿器)
	const kind: Kind = "change";
	// 工具级失败降为 warn:不占接收端的"必须处理"配额
	const severity: Severity = failed ? (warnOnly ? "warn" : "err") : "info";

	const title = failed
		? clamp(`${warnOnly ? "工具失败" : "任务出错"}: ${effectiveError ?? ""}`, MAX_TITLE)
		: clamp(scope ? `变更 ${scope} · ${(snapshot.changedPaths ?? []).length} 个文件${snapshot.git?.pushed ? " · 已推送" : ""}` : buildTitle(snapshot), MAX_TITLE);

	const facts = failed ? buildErrorFacts({ ...snapshot, errorText: effectiveError }) : buildDoneFacts(snapshot);
	const tags = deriveTags({
		tool: snapshot.tool,
		sessionName: snapshot.sessionName,
		cwd: snapshot.cwd,
		repo: snapshot.repo,
		changedPaths: snapshot.changedPaths,
		commands: snapshot.commands,
		severity,
		kind,
	});

	if (scope) tags.push(`dir:${scope}`); // 支持按文件夹订阅

	return {
		id: options.id ?? makeId(new Date(now)),
		ts: now,
		kind,
		severity,
		src: { sess: snapshot.sessionId, tool: snapshot.tool, name: snapshot.sessionName, cwd: snapshot.cwd },
		tags,
		title,
		facts: facts.slice(0, 3),
		action: buildAction(snapshot, kind),
		artifacts: buildArtifacts(snapshot),
		ttl: DEFAULTS.ttlSeconds,
		key: dedupeKey(snapshot, kind),
		seq: snapshot.seq,
	};
}

function buildTitle(snapshot: SessionSnapshot): string {
	if (snapshot.git?.pushed) return `推送 ${snapshot.git.summary ?? "提交"} → ${snapshot.repo ?? "仓库"}`;
	if (snapshot.git?.committed) return `提交 ${snapshot.git.summary ?? ""} → ${snapshot.repo ?? "仓库"}`;
	const changed = uniqueShort(snapshot.changedPaths, 2);
	if (changed.length) return `改动 ${changed.join(", ")}`;
	if (snapshot.sessionName) return `完成:${snapshot.sessionName}`;
	return clamp(snapshot.finalMessage ?? "任务完成", MAX_TITLE);
}

function buildDoneFacts(snapshot: SessionSnapshot): string[] {
	const facts: string[] = [];
	const changed = uniqueShort(snapshot.changedPaths, 3);
	if (changed.length) facts.push(`文件: ${changed.join(", ")}`);
	const commands = snapshot.commands.slice(-2).map((command) => clamp(command, MAX_FACT));
	for (const command of commands) facts.push(`命令: ${command}`);
	if (facts.length < 3 && snapshot.durationMs) facts.push(`耗时: ${Math.round(snapshot.durationMs / 1000)}s`);
	if (facts.length === 0 && snapshot.finalMessage) facts.push(clamp(snapshot.finalMessage, MAX_FACT));
	return facts;
}

function buildErrorFacts(snapshot: SessionSnapshot): string[] {
	const facts: string[] = [];
	if (snapshot.errorText) facts.push(clamp(snapshot.errorText, MAX_FACT));
	const commands = snapshot.commands.slice(-1).map((command) => clamp(command, MAX_FACT));
	for (const command of commands) facts.push(`失败命令: ${command}`);
	const changed = uniqueShort(snapshot.changedPaths, 2);
	if (changed.length && facts.length < 3) facts.push(`涉及文件: ${changed.join(", ")}`);
	return facts;
}

function buildAction(snapshot: SessionSnapshot, kind: Kind): string | undefined {
	if (kind === "task.error") return undefined;
	if (snapshot.git?.pushed && snapshot.repo) return `cd 项目目录 && git log --oneline -3`;
	if (snapshot.repo) return `git -C <项目目录> status --short`;
	return undefined;
}

function buildArtifacts(snapshot: SessionSnapshot): { type: string; ref: string }[] {
	const artifacts: { type: string; ref: string }[] = [];
	if (snapshot.repo) artifacts.push({ type: "repo", ref: snapshot.repo });
	for (const path of snapshot.changedPaths.slice(0, 5)) artifacts.push({ type: "file", ref: path });
	return artifacts;
}
