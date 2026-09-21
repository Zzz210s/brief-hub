#!/usr/bin/env node
/**
 * Claude Code hook 适配器:让 Claude 会话也能投稿与消费简报(零额外 token)。
 *
 * 由 ~/.claude/settings.json 的 hooks 调用,stdin 收 Claude 的 JSON 载荷:
 *   SessionStart      -> 为该会话建立默认订阅(自动推导兴趣标签)
 *   PostToolUse       -> 累积改动路径/命令(只写本地小状态文件,不调模型)
 *   Stop / SessionEnd -> 汇总成简报投稿,并清掉累积状态
 *   UserPromptSubmit  -> 有相关简报时把标题批摘要打到 stdout(Claude 会作为上下文),
 *                        随即标记已读 —— 无相关简报时输出空(0 token)
 *
 * 注意:Claude Code 的 disableAllHooks=true 会让所有 hook 失效;需要在 settings.json
 * 里设为 false 才会生效。本适配器不修改该开关,只提供 hook 配置(见 install-hooks.mjs)。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const REPO = process.env.BRIEF_HUB_HOME || join(homedir(), "brief-hub");

async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch {
		return {};
	}
}

function stateFile(sessionId) {
	return join(homedir(), ".ai-brief-hub", "adapters", "claude", `${sessionId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
}

async function loadState(sessionId, cwd) {
	try {
		return JSON.parse(await readFile(stateFile(sessionId), "utf8"));
	} catch {
		return undefined;
	}
}

async function saveState(state) {
	const file = stateFile(state.sessionId);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(state), "utf8");
}

async function detectRepo(cwd) {
	try {
		const config = await readFile(join(cwd, ".git", "config"), "utf8");
		const match = config.match(/url\s*=\s*(.+)/);
		if (!match) return undefined;
		const parts = match[1].trim().replace(/\.git$/, "").split(/[/:]/).filter(Boolean);
		return parts.slice(-2).join("/");
	} catch {
		return undefined;
	}
}

const main = async () => {
	const payload = await readStdin();
	const event = String(payload.hook_event_name ?? payload.hookEventName ?? "");
	const sessionId = String(payload.session_id ?? payload.sessionId ?? "");
	const cwd = String(payload.cwd ?? process.cwd());
	if (!sessionId) return;

	const core = await import(join(REPO, "src", "index.ts"));
	const transcript = await import(join(REPO, "src", "transcript.ts"));

	if (event === "SessionStart") {
		const existing = await core.readSubscription(sessionId);
		if (!existing) {
			const auto = core
				.deriveTags({ tool: "claude", sessionName: "", cwd, changedPaths: [], commands: [] })
				.filter((tag) => !tag.startsWith("tool:") && !tag.startsWith("sess:") && !tag.startsWith("sev:"));
			await core.writeSubscription(core.defaultSub(sessionId, [...new Set([...auto, "sev:err"])]));
		}
		await core.alignCursor(sessionId);
		await saveState(transcript.emptyState({ sessionId, harness: "claude", cwd, repo: await detectRepo(cwd) }));
		return;
	}

	if (event === "PostToolUse") {
		const call = transcript.toolCallFromHook(payload);
		if (!call) return;
		const state = (await loadState(sessionId, cwd)) ?? transcript.emptyState({ sessionId, harness: "claude", cwd, repo: await detectRepo(cwd) });
		let next = transcript.recordToolCall(state, call.toolName, call.input);
		const response = payload.tool_response ?? payload.toolResponse;
		if (response && typeof response === "object" && (response.is_error || response.isError)) {
			next = transcript.recordFailure(next, JSON.stringify(response).slice(0, 200));
		}
		await saveState(next);
		return;
	}

	if (event === "Stop" || event === "SessionEnd") {
		const state = (await loadState(sessionId, cwd)) ?? transcript.emptyState({ sessionId, harness: "claude", cwd, repo: await detectRepo(cwd) });
		// 兜底:用会话文件补全事实(hook 可能漏掉部分工具调用)
		const transcriptPath = payload.transcript_path ?? payload.transcriptPath;
		let merged = state;
		if (typeof transcriptPath === "string") {
			try {
				const parsed = await transcript.parseClaudeTranscript(transcriptPath);
				merged = {
					...state,
					cwd: parsed.cwd ?? state.cwd,
					changedPaths: [...new Set([...state.changedPaths, ...(parsed.changedPaths ?? [])])].slice(0, 40),
					commands: [...state.commands, ...(parsed.commands ?? [])].slice(-20),
					errorText: state.errorText ?? parsed.errorText,
					finalMessage: parsed.finalMessage ?? state.finalMessage,
				};
			} catch {
				/* 会话文件读不到就用累积状态 */
			}
		}
		const snapshot = transcript.snapshotFromState(merged);
		if (snapshot.changedPaths.length || snapshot.commands.length || snapshot.errorText) {
			await core.appendBrief(core.buildBrief(snapshot));
		}
		await saveState(transcript.emptyState({ sessionId, harness: "claude", cwd: merged.cwd, repo: merged.repo }));
		return;
	}

	if (event === "UserPromptSubmit") {
		// 有相关简报时把摘要打到 stdout(Claude 作为上下文注入);没有则输出空
		const result = await core.pollOnce(sessionId);
		if (result.digest) process.stdout.write(result.digest + "\n");
		return;
	}
};

main().catch(() => process.exit(0)); // hook 绝不阻塞 Claude
