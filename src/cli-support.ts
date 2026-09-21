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

export async function readAllBriefs(files: string[]): Promise<Brief[]> {
	const out: Brief[] = [];
	for (const file of files) {
		const tail = await readAfter(file, 0);
		out.push(...tail.briefs);
	}
	return out.sort((a, b) => b.ts - a.ts);
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
