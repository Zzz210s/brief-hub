#!/usr/bin/env node
/**
 * Codex 适配器:Codex 的 `notify` 钩子在每轮结束时调用本脚本,并把 JSON 作为
 * 最后一个 argv 参数传入(见 openai/codex 的 agent-turn-complete 载荷)。
 *
 *   ~/.codex/config.toml:
 *     notify = ["node", "C:\\Users\\<你>\\brief-hub\\adapters\\codex\\notify.mjs"]
 *
 * 行为:
 *   1) 从载荷取 thread-id / cwd / 最后一条助手消息
 *   2) 尽力从 Codex 会话 rollout(在 ~/.codex/sessions 下按 thread-id 找 jsonl)补工具事实
 *   3) 投一条简报(出错特征命中则标 task.error)
 *   4) 再把待读摘要打到 stdout —— Codex 忽略它也无害(便于手工观察)
 *
 * 成本:0 额外 token(不做模型摘要)。hook 失败绝不阻塞 Codex。
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.env.BRIEF_HUB_HOME || join(homedir(), "brief-hub");

async function readStdin() {
	if (process.stdin.isTTY) return "";
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8").trim();
}

/** Codex 把 JSON 作为最后一个 argv 传入;也兼容从 stdin 读(便于测试) */
async function payloadFromArgvOrStdin() {
	const last = process.argv[process.argv.length - 1] ?? "";
	if (last.trim().startsWith("{")) {
		try {
			return JSON.parse(last);
		} catch {
			/* 落到 stdin */
		}
	}
	const fromStdin = await readStdin();
	try {
		return JSON.parse(fromStdin || "{}");
	} catch {
		return {};
	}
}

/** 找该 thread 最新的 rollout 文件(找不到就返回 undefined) */
async function findRollout(threadId) {
	if (!threadId) return undefined;
	const root = join(homedir(), ".codex", "sessions");
	const stack = [root];
	let best;
	while (stack.length) {
		const dir = stack.pop();
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.name.includes(threadId) && entry.name.endsWith(".jsonl")) {
				const info = await stat(full).catch(() => undefined);
				if (info && (!best || info.mtimeMs > best.mtimeMs)) best = { full, mtimeMs: info.mtimeMs };
			}
		}
	}
	return best?.full;
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
	const payload = await payloadFromArgvOrStdin();
	const core = await import(pathToFileURL(join(REPO, "src", "index.ts")).href);
	const transcript = await import(pathToFileURL(join(REPO, "src", "transcript.ts")).href);

	const threadId = String(payload["thread-id"] ?? payload.threadId ?? "");
	const cwd = String(payload.cwd ?? process.cwd());

	let facts = {};
	const rollout = await findRollout(threadId);
	if (rollout) {
		try {
			const text = await readFile(rollout, "utf8");
			facts = transcript.factsFromGenericJsonl(text);
		} catch {
			/* 读不到就算了 */
		}
	}

	const snapshot = transcript.snapshotFromCodexNotify(payload, {
		...facts,
		repo: await detectRepo(cwd),
		changedPaths: facts.changedPaths ?? [],
		commands: facts.commands ?? [],
	});

	// 没有事实、也没有助手消息 -> 不值得投
	if (!snapshot.changedPaths.length && !snapshot.commands.length && !snapshot.finalMessage) return;

	const brief = core.buildBrief(snapshot);
	await core.appendBrief(brief);
	process.stdout.write(`[brief-hub] 已投稿 ${brief.id} [${brief.kind}] ${brief.title}\n`);
};

main().catch((error) => {
	// 出错也不阻塞 Codex,但写到 stderr 便于排查(Codex 会忽略)
	process.stderr.write(`[brief-hub] ${error instanceof Error ? error.message : String(error)}
`);
	process.exit(0);
});
