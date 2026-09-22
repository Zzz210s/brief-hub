/**
 * CLI 辅助:参数解析与简报读取(与 cli.ts 分开以守住 200 行上限)。
 */

import { readAfter } from "./store.ts";
import { join } from "node:path";
import type { Brief } from "./schema.ts";

export interface Args {
	command: string;
	rest: string[];
	flags: Record<string, string[]>;
	bool: Set<string>;
}

/** 支持 `--key value` / `--key` / 位置参数 */
export function parseArgs(argv: string[]): Args {
	const args: Args = { command: "", rest: [], flags: {}, bool: new Set() };
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token.startsWith("--")) {
			const eq = token.indexOf("=");
			if (eq > 0) {
				(args.flags[token.slice(2, eq)] ??= []).push(token.slice(eq + 1));
				continue;
			}
			const key = token.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				(args.flags[key] ??= []).push(next);
				i++;
			} else {
				args.bool.add(key);
			}
			continue;
		}
		if (!args.command) args.command = token;
		else args.rest.push(token);
	}
	return args;
}

export function one(flags: Record<string, string[]>, key: string): string | undefined {
	return flags[key]?.[0];
}

/** 读取简报:默认走尾部有界读取(不整文件扫描),onlyForList 时按 limit 截断 */
export async function readAllBriefs(files: string[], options: { limit?: number; tailBytes?: number } = {}): Promise<Brief[]> {
	const { readRecentBriefs } = await import("./store.ts");
	const { DEFAULTS } = await import("./schema.ts");
	return readRecentBriefs(files, options.tailBytes ?? DEFAULTS.listTailBytes, options.limit ?? 200);
}

/** 跨 harness 补投:从别的工具的会话文件(目前支持 Claude Code JSONL)推导并投稿 */
export async function publishFromTranscript(options: {
	path: string;
	harness?: string;
	sessionId?: string;
	name?: string;
	repo?: string;
	cwd?: string;
}): Promise<string> {
	const [{ buildBrief }, { appendBrief }, transcript] = await Promise.all([
		import("./brief.ts"),
		import("./store.ts"),
		import("./transcript.ts"),
	]);
	const parsed = await transcript.parseClaudeTranscript(options.path);
	const brief = buildBrief({
		sessionId: options.sessionId ?? `${options.harness ?? "claude"}-${process.pid}`,
		tool: options.harness ?? "claude",
		sessionName: options.name ?? `${options.harness ?? "claude"}:backfill`,
		cwd: parsed.cwd ?? options.cwd ?? process.cwd(),
		repo: options.repo,
		changedPaths: parsed.changedPaths ?? [],
		commands: parsed.commands ?? [],
		errorText: parsed.errorText,
		finalMessage: parsed.finalMessage,
	});
	await appendBrief(brief);
	return `已补投 ${brief.id} [${brief.kind}] ${brief.title}`;
}

/** 自检:数据目录、命令、检测到的 AI 工具与适配器接线状态(不依赖任何 AI) */
export interface DoctorRow { name: string; ok: boolean; detail: string }

export async function doctorRows(): Promise<DoctorRow[]> {
	const { homedir } = await import("node:os");
	const { existsSync } = await import("node:fs");
	const { hubRoot } = await import("./store.ts");
	const rows: DoctorRow[] = [];
	rows.push({ name: "node", ok: Number(process.versions.node.split(".")[0]) >= 24, detail: `v${process.versions.node}` });
	rows.push({ name: "数据目录", ok: existsSync(hubRoot()), detail: hubRoot() });
	rows.push({ name: "简报目录", ok: existsSync(join(hubRoot(), "briefs")), detail: join(hubRoot(), "briefs") });
	rows.push({ name: "订阅目录", ok: existsSync(join(hubRoot(), "subs")), detail: join(hubRoot(), "subs") });

	const harnesses: [string, string][] = [
		["pi", join(homedir(), ".pi", "agent")],
		["Claude Code", join(homedir(), ".claude")],
		["Codex", join(homedir(), ".codex", "config.toml")],
		["opencode", join(homedir(), ".config", "opencode")],
	];
	for (const [name, path] of harnesses) {
		const present = existsSync(path);
		rows.push({ name: `harness ${name}`, ok: present, detail: present ? path : "未安装(不影响 CLI)" });
	}
	const piExt = existsSync(join(homedir(), ".pi", "agent", "extensions", "brief-subscriber.ts"));
	rows.push({ name: "pi 扩展", ok: piExt, detail: piExt ? "已安装投稿器/订阅器" : "未安装(可选)" });
	const claudeHook = await (async () => {
		try {
			const raw = await import("node:fs/promises").then((fs) => fs.readFile(join(homedir(), ".claude", "settings.json"), "utf8"));
			return raw.includes("adapters") && raw.includes("hook.mjs");
		} catch {
			return false;
		}
	})();
	rows.push({ name: "Claude hook", ok: claudeHook, detail: claudeHook ? "已合并" : "未安装(可选)" });
	return rows;
}

/** 把 doctor 结果渲染成文本 */
export function formatDoctor(rows: DoctorRow[]): string {
	const lines = rows.map((row) => `${row.ok ? "OK  " : "--  "} ${row.name.padEnd(18)} ${row.detail}`);
	lines.push("");
	lines.push("提示:CLI 与集散地本身不依赖任何 AI;上表未安装的 harness 只是可选接线缺席。");
	return lines.join("\n");
}

/** 标记"已处理"(handled)或"已延迟"(deferred);返回是否成功 */
export async function markHandling(sess: string, ids: string[], mode: "handle" | "defer", now = Date.now()): Promise<{ ok: number; state: unknown }> {
	const { readState, writeState } = await import("./store.ts");
	const state = await readState(sess);
	const handled = { ...(state.handled ?? {}) };
	const deferred = { ...(state.deferred ?? {}) };
	let ok = 0;
	for (const id of ids) {
		if (mode === "handle") {
			handled[id] = now;
			delete deferred[id];
		} else {
			deferred[id] = now;
		}
		ok++;
	}
	const next = { ...state, handled, deferred, unread: (state.unread ?? []).filter((id) => !ids.includes(id)) };
	await writeState(sess, next);
	return { ok, state: next };
}

/** 列出需要处理的简报(按动作类分组) */
export async function pendingFor(sess: string, now = Date.now()): Promise<string> {
	const [{ listBriefFiles, readSubscription }, { readRecentBriefs }, handling, schema] = await Promise.all([
		import("./store.ts"),
		import("./store-config.ts"),
		import("./handling.ts"),
		import("./schema.ts"),
	]);
	const sub = await readSubscription(sess);
	if (!sub) return `无订阅:先 bh sub add <标签> --sess=${sess}`;
	const files = await listBriefFiles(3);
	const briefs = await readRecentBriefs(files, schema.DEFAULTS.listTailBytes, 200);
	const { readState } = await import("./store.ts");
	const state = await readState(sess);
	const items = briefs
		.filter((brief) => (sub.tags ?? []).some((tag) => (brief.tags ?? []).includes(tag)) || brief.severity === "err")
		.filter((brief) => handling.shouldSurface(brief, state, now))
		.map((brief) => ({ brief, action: handling.classify(brief, sub), resurfaced: Boolean(state.deferred?.[brief.id]) }));
	const text = handling.renderProtocol(items, { maxPerClass: 8 });
	const stats = handling.handlingStats(state, now);
	return `${text ?? "无待处理简报"}

(已处理 ${stats.handled} · 延迟中 ${stats.deferred} · 延迟到期 ${stats.deferredDue})`;
}

/** 当前待处理的简报 id(供 bh handle/defer 省略 id 时使用) */
export async function pendingIds(sess: string, now = Date.now()): Promise<string[]> {
	const [{ listBriefFiles, readState, readSubscription }, { readRecentBriefs }, handling, schema] = await Promise.all([
		import("./store.ts"),
		import("./store-config.ts"),
		import("./handling.ts"),
		import("./schema.ts"),
	]);
	const sub = await readSubscription(sess);
	if (!sub) return [];
	const files = await listBriefFiles(3);
	const briefs = await readRecentBriefs(files, schema.DEFAULTS.listTailBytes, 200);
	const state = await readState(sess);
	return briefs
		.filter((brief) => (sub.tags ?? []).some((tag) => (brief.tags ?? []).includes(tag)) || brief.severity === "err")
		.filter((brief) => handling.shouldSurface(brief, state, now))
		.map((brief) => brief.id);
}

/** P3:列出"没有任何会话处理过"的简报(孤儿)-> 一眼看出谁在持续产噪声 */
export async function orphansFor(now = Date.now(), limit = 12): Promise<string> {
	const [{ listBriefFiles, readState, listSubscriptions }, { readRecentBriefs }, schema, fs] = await Promise.all([
		import("./store.ts"),
		import("./store-config.ts"),
		import("./schema.ts"),
		import("node:fs/promises"),
	]);
	const subs = await listSubscriptions();
	const states = await Promise.all(subs.map((sub) => readState(sub.sess)));
	const touched = new Set<string>();
	for (const state of states) {
		for (const id of state.consumed ?? []) touched.add(id);
		for (const id of Object.keys(state.handled ?? {})) touched.add(id);
		for (const id of Object.keys(state.deferred ?? {})) touched.add(id);
	}
	const files = await listBriefFiles(7);
	const briefs = await readRecentBriefs(files, schema.DEFAULTS.listTailBytes, 300);
	const orphans = briefs.filter((brief) => !touched.has(brief.id));
	if (orphans.length === 0) return "无孤儿简报(每条都被至少一个会话处理过)";
	const lines = [`孤儿简报 ${orphans.length} 条(无会话 consumed/handled,可能是噪声或订阅不匹配):`];
	for (const brief of orphans.slice(0, limit)) {
		lines.push(`  ${new Date(brief.ts).toISOString().slice(5, 16)} [${brief.severity}] ${brief.title.slice(0, 46)}  (${brief.id})`);
	}
	if (orphans.length > limit) lines.push(`  … 另有 ${orphans.length - limit} 条`);
	const bySeverity: Record<string, number> = {};
	for (const brief of orphans) bySeverity[brief.severity] = (bySeverity[brief.severity] ?? 0) + 1;
	lines.push(`按严重度:${Object.entries(bySeverity).map(([k, v]) => `${k}=${v}`).join(" ")}`);
	return lines.join("\n");
}

/**
 * P4:硬清理历史简报 —— 命中的简报先落成一个 jsonl 再**移入系统回收站**(可还原),
 * 随后从归档文件与标签分片里剔除,并清掉各会话状态里的 unread。
 * apply=false 时只预览。
 */
export async function purgeBriefs(filter: import("./purge.ts").PurgeFilter, apply: boolean): Promise<string> {
	const [{ listBriefFiles, hubRoot }, { readRecentBriefs }, schema, purge, recycle, fs] = await Promise.all([
		import("./store.ts"),
		import("./store-config.ts"),
		import("./schema.ts"),
		import("./purge.ts"),
		import("./recycle.ts"),
		import("node:fs/promises"),
	]);
	const files = await listBriefFiles(14);
	const briefs = await readRecentBriefs(files, schema.DEFAULTS.listTailBytes * 4, 500);
	const ids = purge.selectForPurge(briefs, filter);
	const lines = [`命中 ${ids.length} 条${apply ? "" : "(预览,未改动)"}`];
	const hit = briefs.filter((b) => ids.includes(b.id));
	for (const brief of hit.slice(0, 8)) {
		lines.push(`  ${new Date(brief.ts).toISOString().slice(5, 16)} [${brief.severity}] ${brief.title.slice(0, 46)}  (${brief.id})`);
	}
	if (ids.length > 8) lines.push(`  … 另有 ${ids.length - 8} 条`);
	if (!apply || ids.length === 0) {
		if (!apply && ids.length > 0) lines.push("确认后加 --yes 执行(命中内容移入系统回收站,归档与分片同步剔除)");
		return lines.join("\n");
	}

	const trashDir = join(hubRoot(), "trash");
	await fs.mkdir(trashDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const trashFile = join(trashDir, `purged-${stamp}.jsonl`);
	await fs.writeFile(trashFile, hit.map((b) => JSON.stringify(b)).join("\n") + "\n", "utf8");
	const recycled = await recycle.toRecycleBin(trashFile);

	let touched = 0;
	const rewrite = async (path: string): Promise<void> => {
		try {
			const text = await fs.readFile(path, "utf8");
			const result = purge.stripBriefs(text, ids);
			if (result.removed > 0) {
				await fs.writeFile(path, result.kept, "utf8");
				touched++;
			}
		} catch {
			/* 忽略不存在/读失败 */
		}
	};
	for (const file of files) await rewrite(file);
	try {
		for (const name of await fs.readdir(join(hubRoot(), "shards"))) await rewrite(join(hubRoot(), "shards", name));
	} catch {
		/* 无分片目录 */
	}
	lines.push(`已从 ${touched} 个文件剔除;命中内容${recycled ? "已移入系统回收站" : "已删除(回收站不可用)"}`);
	return lines.join("\n");
}
