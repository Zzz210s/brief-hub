/**
 * CLI 辅助:参数解析与简报读取(与 cli.ts 分开以守住 200 行上限)。
 */

import { readAfter } from "./store.ts";
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
