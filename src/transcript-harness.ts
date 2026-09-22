import { readFile } from "node:fs/promises";
import type { SessionSnapshot } from "./brief.ts";

/** Codex notify 载荷 -> 简报快照(纯函数) */
const ERROR_HINTS = /(error|failed|exception|traceback|ERR_|错误|失败|异常)/i;

export function snapshotFromCodexNotify(payload: CodexNotifyPayload, extra: Partial<SessionSnapshot> = {}): SessionSnapshot {
	const last = String(payload["last-assistant-message"] ?? "");
	const failed = ERROR_HINTS.test(last);
	const cwd = payload.cwd ?? process.cwd();
	return {
		sessionId: payload["thread-id"] ?? `codex-${process.pid}`,
		tool: "codex",
		sessionName: extra.sessionName ?? `codex:${String(payload["thread-id"] ?? "").slice(0, 8)}`,
		cwd,
		repo: extra.repo,
		changedPaths: extra.changedPaths ?? [],
		commands: extra.commands ?? [],
		errorText: failed ? last.slice(0, 200) : undefined,
		finalMessage: last.slice(0, 200),
		...extra,
	};
}

/* ---------- 通用:从任意 harness 的 JSONL 里尽力抽取事实 ---------- */

/**
 * 面向"没有专用解析器"的 harness(如 Codex rollout、其它 CLI 的日志):
 * 逐行找 file_path / command 字符串,忽略结构差异。宁可少抽,不要瞎猜。
 */

export function factsFromGenericJsonl(text: string, limit = 40): Partial<SessionSnapshot> {
	const changedPaths: string[] = [];
	const commands: string[] = [];
	let cwd: string | undefined;
	let errorText: string | undefined;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const pathMatch = line.match(/"(?:file_path|filePath|path)"\s*:\s*"([^"]+)"/);
		if (pathMatch && changedPaths.length < limit && !changedPaths.includes(pathMatch[1])) changedPaths.push(pathMatch[1]);
		const cmdMatch = line.match(/"(?:command|cmd)"\s*:\s*"([^"]+)"/);
		if (cmdMatch) commands.push(cmdMatch[1].replace(/\\"/g, '"').replace(/\s+/g, " ").slice(0, 120));
		const cwdMatch = line.match(/"cwd"\s*:\s*"([^"]+)"/);
		if (cwdMatch && !cwd) cwd = cwdMatch[1];
		if (!errorText && /"(?:is_error|isError)"\s*:\s*true/.test(line)) errorText = line.slice(0, 200);
	}
	return { cwd, changedPaths, commands: commands.slice(-20), errorText };
}
