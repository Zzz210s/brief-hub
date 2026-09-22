/**
 * 投稿器(pi 扩展):任务完成/出错时,自动向简报集散地投一条简报。
 *
 * 成本:0 额外 token —— 标题与要点都从"本次会话已有产物"派生(改动路径、执行过的
 * 命令、错误文本、会话名),不调用模型做摘要。
 *
 * 启用:BRIEF_HUB=0 关闭;BRIEF_HUB_HOME 指定仓库目录(默认 ~/brief-hub)。
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.env.BRIEF_HUB_HOME || join(homedir(), "brief-hub");
const WRITE_TOOLS = new Set(["edit", "write", "multi_edit", "apply_patch", "str_replace_editor"]);
const MAX_TRACKED = 40;

interface Meta {
	sessionId: string;
	name: string;
	cwd: string;
}

async function detectRepo(cwd: string): Promise<string | undefined> {
	try {
		const config = await readFile(join(cwd, ".git", "config"), "utf8");
		const match = config.match(/url\s*=\s*(.+)/);
		if (!match) return undefined;
		const url = match[1].trim().replace(/\.git$/, "");
		const parts = url.split(/[/:]/).filter(Boolean);
		return parts.slice(-2).join("/");
	} catch {
		return undefined;
	}
}

export default function (pi: any): void {
	if (process.env.BRIEF_HUB === "0") return;

	let meta: Meta = { sessionId: "", name: "", cwd: process.cwd() };
	let changed = new Set<string>();
	let commands: string[] = [];
	let lastError: string | undefined;
	let warnError: string | undefined; // 工具级失败:降级为 warn
	let startedAt = Date.now();
	let seq = 0;

	const resetWork = (): void => {
		changed = new Set<string>();
		commands = [];
		lastError = undefined;
		warnError = undefined;
		startedAt = Date.now();
	};

	const publish = async (): Promise<void> => {
		// 只投变更简报:必须有文件夹改动(出错/纯跑命令都不投)
		const hasWork = changed.size > 0;
		if (!hasWork) return;
		try {
			const core = await import(pathToFileURL(join(REPO, "src", "index.ts")).href);
			const repo = await detectRepo(meta.cwd);
			const brief = core.buildBrief(
				{
					sessionId: meta.sessionId || `pi-${process.pid}`,
					tool: "pi",
					sessionName: meta.name,
					cwd: meta.cwd,
					repo,
					durationMs: Date.now() - startedAt,
					changedPaths: [...changed],
					commands: commands.slice(-3),
					errorText: lastError ?? warnError,
					seq: ++seq,
				},
				{},
			);
			// 工具级失败降级:不占接收端的"必须处理"配额(P2)
			if (!lastError && warnError && brief.severity === "err") {
				brief.severity = "warn";
				brief.title = core.clamp(`工具失败: ${warnError}`, 60);
			}
			await core.appendBrief(brief);
		} catch {
			/* 投稿失败绝不影响会话 */
		} finally {
			resetWork();
		}
	};

	pi.on("session_start", async (_event: unknown, ctx: any) => {
		try {
			meta = {
				sessionId: ctx?.sessionManager?.getSessionId?.() ?? "",
				name: ctx?.sessionManager?.getSessionName?.() ?? "",
				cwd: ctx?.sessionManager?.getCwd?.() ?? process.cwd(),
			};
		} catch {
			/* 保持默认 */
		}
		resetWork();
	});

	pi.on("session_info_changed", async (event: any) => {
		if (event?.name) meta.name = event.name;
	});

	pi.on("tool_execution_end", async (event: any) => {
		try {
			const name = String(event?.toolName ?? event?.name ?? "");
			const input = event?.input ?? event?.args ?? {};
			if (WRITE_TOOLS.has(name)) {
				const path = input.file_path ?? input.path ?? input.filePath ?? input.filename;
				if (typeof path === "string" && changed.size < MAX_TRACKED) changed.add(path);
			}
			if (name === "bash" || name === "shell" || name === "run_command") {
				const command = input.command ?? input.cmd ?? input.script;
				if (typeof command === "string") commands.push(command.replace(/\s+/g, " ").slice(0, 120));
			}
			const failed = event?.isError ?? event?.error ?? event?.result?.isError;
			if (failed) {
				// 统一提取(对象/数组/工具结果包装)+ 分类:瞬时噪声不广播(P0)
				const core = await import(pathToFileURL(join(REPO, "src", "index.ts")).href);
				const text = core.errorText(event?.error ?? event?.result, 120);
				const klass = text ? core.errorClass(text) : "noise";
				if (klass === "task") lastError = text;            // 任务级 -> sev:err
				else if (klass === "tool") warnError = text;       // 工具级 -> sev:warn(不占"必须处理")
			}
		} catch {
			/* 忽略采集异常 */
		}
	});

	pi.on("agent_settled", async () => {
		await publish();
	});

	pi.on("session_shutdown", async () => {
		await publish();
	});
}
