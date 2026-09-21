/**
 * 跨 harness 适配层:把"别的 AI 工具"的会话事实换算成简报快照。
 *
 * 设计:核心只认 SessionSnapshot(见 brief.ts),各 harness 的差异全部挡在这里 ——
 *   - Claude Code:JSONL 会话文件(~/.claude/projects/<slug>/<uuid>.jsonl)
 *     以及 hook 直投的载荷(PostToolUse 的 tool_name/tool_input)
 *   - 其它 harness:自己把事实整理成同一形状,或直接调 bh publish
 *
 * 纯函数为主(可单测),文件读取单独放 parseClaudeTranscript。
 */

import { readFile } from "node:fs/promises";
import type { SessionSnapshot } from "./brief.ts";

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "edit", "write"]);
const SHELL_TOOLS = new Set(["Bash", "bash", "shell", "run_command"]);

export interface HarnessState {
	sessionId: string;
	harness: string;
	cwd: string;
	repo?: string;
	changedPaths: string[];
	commands: string[];
	errorText?: string;
	finalMessage?: string;
	startedAt: number;
	seq: number;
}

export function emptyState(init: Partial<HarnessState> & { sessionId: string; harness: string }): HarnessState {
	return {
		cwd: process.cwd(),
		changedPaths: [],
		commands: [],
		startedAt: Date.now(),
		seq: 0,
		...init,
	};
}

/** 记录一次工具调用(纯函数,返回新状态;数组有界) */
export function recordToolCall(state: HarnessState, toolName: string, input: Record<string, unknown> = {}): HarnessState {
	const next: HarnessState = { ...state, changedPaths: [...state.changedPaths], commands: [...state.commands] };
	if (WRITE_TOOLS.has(toolName)) {
		const path = [input.file_path, input.path, input.filePath, input.filename].find((value) => typeof value === "string") as
			| string
			| undefined;
		if (path && next.changedPaths.length < 40 && !next.changedPaths.includes(path)) next.changedPaths.push(path);
	}
	if (SHELL_TOOLS.has(toolName)) {
		const command = [input.command, input.cmd, input.script].find((value) => typeof value === "string") as string | undefined;
		if (command) {
			next.commands.push(command.replace(/\s+/g, " ").slice(0, 120));
			if (next.commands.length > 20) next.commands = next.commands.slice(-20);
		}
	}
	return next;
}

/** 记录一次失败(纯函数) */
export function recordFailure(state: HarnessState, text: string): HarnessState {
	return { ...state, errorText: text.slice(0, 200) };
}

/** 状态 -> 简报快照(纯函数) */
export function snapshotFromState(state: HarnessState, overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
	const pushed = state.commands.some((command) => /\bgit\s+push\b/.test(command));
	const committed = state.commands.some((command) => /\bgit\s+commit\b/.test(command));
	return {
		sessionId: state.sessionId,
		tool: state.harness,
		sessionName: overrides.sessionName ?? `${state.harness}:${state.sessionId.slice(0, 8)}`,
		cwd: state.cwd,
		repo: state.repo,
		durationMs: Date.now() - state.startedAt,
		changedPaths: state.changedPaths,
		commands: state.commands,
		errorText: state.errorText,
		finalMessage: state.finalMessage,
		git: pushed ? { pushed, summary: lastGitSubject(state.commands) } : committed ? { committed, summary: lastGitSubject(state.commands) } : undefined,
		seq: ++state.seq,
		...overrides,
	};
}

function lastGitSubject(commands: string[]): string | undefined {
	for (const command of [...commands].reverse()) {
		const match = command.match(/-m\s+["']([^"']+)["']/);
		if (match) return match[1].slice(0, 60);
	}
	return undefined;
}

/** Claude Code hook 载荷 -> (toolName, input)(兼容不同事件形状) */
export function toolCallFromHook(payload: Record<string, unknown>): { toolName: string; input: Record<string, unknown> } | undefined {
	const toolName = (payload.tool_name ?? payload.toolName ?? "") as string;
	if (!toolName) return undefined;
	const input = (payload.tool_input ?? payload.toolInput ?? payload.input ?? {}) as Record<string, unknown>;
	return { toolName, input };
}

/**
 * 解析 Claude Code 会话文件(JSONL):抽出改动路径、执行过的命令、失败信息与末条助手文本。
 * 用于"补投"(hook 没装或漏掉的会话)与历史回填。
 */
export async function parseClaudeTranscript(file: string): Promise<Partial<SessionSnapshot>> {
	const raw = await readFile(file, "utf8");
	const changedPaths: string[] = [];
	const commands: string[] = [];
	let errorText: string | undefined;
	let finalMessage: string | undefined;
	let cwd: string | undefined;

	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (typeof entry.cwd === "string" && !cwd) cwd = entry.cwd;
		const message = entry.message as { content?: unknown } | undefined;
		const content = message?.content;
		if (typeof content === "string") {
			if (entry.type === "assistant") finalMessage = content.slice(0, 200);
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const block of content as Record<string, unknown>[]) {
			if (block.type === "text" && entry.type === "assistant" && typeof block.text === "string") {
				finalMessage = String(block.text).slice(0, 200);
				continue;
			}
			if (block.type !== "tool_use") continue;
			const toolName = String(block.name ?? "");
			const input = (block.input ?? {}) as Record<string, unknown>;
			if (WRITE_TOOLS.has(toolName)) {
				const path = [input.file_path, input.path, input.filePath].find((value) => typeof value === "string") as string | undefined;
				if (path && changedPaths.length < 40 && !changedPaths.includes(path)) changedPaths.push(path);
			}
			if (SHELL_TOOLS.has(toolName)) {
				const command = [input.command, input.cmd].find((value) => typeof value === "string") as string | undefined;
				if (command) commands.push(command.replace(/\s+/g, " ").slice(0, 120));
			}
			if (block.is_error || (block as { isError?: unknown }).isError) errorText = JSON.stringify(block).slice(0, 200);
		}
		if (Array.isArray(content)) {
			for (const block of content as Record<string, unknown>[]) {
				if (block.type === "tool_result" && (block.is_error || block.isError)) {
					errorText = JSON.stringify(block.content ?? block).slice(0, 200);
				}
			}
		}
	}
	return { cwd, changedPaths, commands, errorText, finalMessage };
}

/* ---------- Codex(notify hook) ---------- */

/**
 * Codex 的 `notify` 钩子在每轮结束时把 JSON 作为**最后一个 argv 参数**传给我们
 * (见 openai/codex 的 user_notification.rs:agent-turn-complete)。
 * 字段为 kebab-case。
 */
export interface CodexNotifyPayload {
	"type"?: string;
	"thread-id"?: string;
	"turn-id"?: string;
	cwd?: string;
	"input-messages"?: string[];
	"last-assistant-message"?: string;
}

const ERROR_HINTS = /(error|failed|exception|traceback|ERR_|错误|失败|异常)/i;

/** Codex notify 载荷 -> 简报快照(纯函数) */
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
