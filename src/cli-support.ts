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

export { doctorRows, formatDoctor } from "./cli-doctor.ts";
export { orphansFor } from "./cli-orphans.ts";
export { purgeBriefs } from "./cli-purge.ts";
export { markHandling, pendingFor, pendingIds } from "./cli-pending.ts";
