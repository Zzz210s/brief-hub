/**
 * opencode 适配器(插件形式)
 *
 * 安装:把本文件拷到 ~/.config/opencode/plugin/brief-hub.js(或项目内 .opencode/plugins/)
 * 之后 opencode 会自动加载(见 opencode 官方 Plugins 文档)。
 *
 * 两个作用点(都来自官方 plugin API):
 *   - chat.message:用户消息在发给模型**之前**触发,可向 output.parts 注入内容 ——
 *     这里注入"待读简报摘要"(没有相关简报时**不注入**,0 token)。
 *   - event:订阅 session.idle / session.error / session.deleted ——
 *     idle 时投稿一条简报(事实来自该会话最近消息,尽力而为)。
 *
 * 依赖:node 可用 + brief-hub CLI(bh)。插件本身不引入额外包。
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = process.env.BRIEF_HUB_HOME || join(homedir(), "brief-hub");
const CLI = join(REPO, "src", "cli.ts");
const NODE = process.execPath;

/** 调用 bh CLI(超时保护,失败返回空串) */
export function runBh(args, timeout = 8000) {
	return new Promise((resolve) => {
		if (!existsSync(CLI)) return resolve("");
		execFile(NODE, ["--no-warnings", CLI, ...args], { timeout, windowsHide: true }, (error, stdout) => {
			resolve(error ? "" : String(stdout ?? ""));
		});
	});
}

/** 把摘要包成一个注入用的文本(纯函数,便于单测) */
export function digestPart(digest) {
	const text = String(digest ?? "").trim();
	if (!text) return undefined;
	return { type: "text", text: `[brief-hub] 会话间简报:\n${text}` };
}

/** 向 opencode 的消息 parts 注入摘要(纯函数,便于单测) */
export function injectDigest(parts, digest) {
	const part = digestPart(digest);
	if (!part) return parts;
	return [...parts, part];
}

export const BriefHubPlugin = async ({ directory }) => {
	const cwd = directory ?? process.cwd();
	return {
		"chat.message": async (input, output) => {
			const digest = await runBh(["digest", `--sess=${input?.sessionID ?? ""}`]);
			if (!digest.trim()) return;
			output.parts = injectDigest(output.parts ?? [], digest);
		},
		event: async ({ event }) => {
			const type = event?.type ?? "";
			if (type !== "session.idle" && type !== "session.error" && type !== "session.deleted") return;
			const sessionId = event?.properties?.sessionID ?? event?.properties?.info?.id ?? "";
			if (!sessionId) return;
			const args = ["publish", "--tool", "opencode", "--sess-id", sessionId, "--name", "opencode", "--cwd", cwd];
			if (type === "session.error") {
				const message = JSON.stringify(event?.properties?.error ?? "session error").slice(0, 200);
				args.push("--error", message);
			}
			await runBh(args);
		},
	};
};

export default BriefHubPlugin;
