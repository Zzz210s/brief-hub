#!/usr/bin/env node
/**
 * 把 brief-hub 的 Claude Code hooks 合并进 ~/.claude/settings.json(幂等、不破坏已有 hook)。
 *
 * 注意:Claude Code 里 disableAllHooks=true 会让所有 hook 失效 —— 本脚本只做合并,
 * 不会替你改这个开关(需要你确认后手动设为 false)。
 */
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const settingsPath = join(homedir(), ".claude", "settings.json");
const hookPath = join(process.env.BRIEF_HUB_HOME || join(homedir(), "brief-hub"), "adapters", "claude", "hook.mjs");
const command = `node "${hookPath}"`;
const want = {
	PostToolUse: { matcher: "", hooks: [{ type: "command", command, timeout: 15 }] },
	Stop: { matcher: "", hooks: [{ type: "command", command, timeout: 20 }] },
	SessionStart: { matcher: "", hooks: [{ type: "command", command, timeout: 15 }] },
	SessionEnd: { matcher: "", hooks: [{ type: "command", command, timeout: 20 }] },
	UserPromptSubmit: { matcher: "", hooks: [{ type: "command", command, timeout: 15 }] },
};

const raw = JSON.parse(await readFile(settingsPath, "utf8").catch(() => "{}"));
raw.hooks ??= {};
let added = 0;
for (const [event, entry] of Object.entries(want)) {
	raw.hooks[event] ??= [];
	const already = JSON.stringify(raw.hooks[event]).includes("adapters/claude/hook.mjs")
		|| JSON.stringify(raw.hooks[event]).includes("adapters\\claude\\hook.mjs");
	if (already) continue;
	raw.hooks[event].push(entry);
	added++;
}
await writeFile(settingsPath, JSON.stringify(raw, null, "\t"), "utf8");
console.log(`已合并 ${added} 个 hook 到 ${settingsPath}`);
console.log(raw.disableAllHooks ? "警告: disableAllHooks=true —— hook 不会生效,需改为 false" : "disableAllHooks 未开启,可生效");
