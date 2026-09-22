import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { factsFromGenericJsonl, snapshotFromCodexNotify } from "../src/transcript.ts";
import { digestPart, injectDigest } from "../adapters/opencode/plugin.js";

const run = promisify(execFile);

test("Codex:agent-turn-complete 载荷 -> 快照(错误特征标 err)", () => {
	const ok = snapshotFromCodexNotify({ "thread-id": "abc12345", cwd: "E:/proj", "last-assistant-message": "已完成配置改造" });
	assert.equal(ok.tool, "codex");
	assert.equal(ok.sessionId, "abc12345");
	assert.equal(ok.errorText, undefined);
	const bad = snapshotFromCodexNotify({ "thread-id": "x", cwd: "E:/p", "last-assistant-message": "Error: pnpm failed 无法完成" });
	assert.match(bad.errorText ?? "", /Error/);
});

test("通用 JSONL 抽取:file_path / command / cwd / is_error", () => {
	const facts = factsFromGenericJsonl(
		[
			'{"type":"item","payload":{"cwd":"E:/proj"}}',
			'{"payload":{"path":"config-ai/README.md"}}',
			'{"payload":{"command":"git push origin master"}}',
			'{"payload":{"is_error":true}}',
		].join("\n"),
	);
	assert.equal(facts.cwd, "E:/proj");
	assert.deepEqual(facts.changedPaths, ["config-ai/README.md"]);
	assert.deepEqual(facts.commands, ["git push origin master"]);
	assert.ok(facts.errorText);
});

test("opencode:摘要注入 parts;空摘要不注入(0 token)", () => {
	assert.equal(digestPart(""), undefined);
	const injected = injectDigest([{ type: "text", text: "用户问题" }], "简报集散地:1 条相关");
	assert.equal(injected.length, 2);
	assert.match(injected[1].text, /会话间简报/);
	assert.deepEqual(injectDigest([{ type: "text", text: "x" }], ""), [{ type: "text", text: "x" }]);
});

test("Codex 适配器端到端:载荷 -> 简报落盘(零模型调用)", async () => {
	const hub = await mkdtemp(join(tmpdir(), "bh-codex-"));
	const payload = JSON.stringify({ type: "agent-turn-complete", "thread-id": "thread-xyz", cwd: process.cwd(), "last-assistant-message": "完成:改了配置" });
	const { stdout } = await run(process.execPath, [join(process.cwd(), "adapters/codex/notify.mjs"), payload], {
		env: { ...process.env, BRIEF_HUB_HOME_OVERRIDE: hub, BRIEF_HUB_HOME: process.cwd() },
	});
	assert.match(stdout, /已投稿/);
	const files = await readdir(join(hub, "briefs"));
	const brief = JSON.parse((await readFile(join(hub, "briefs", files[0]), "utf8")).trim().split("\n").pop());
	assert.equal(brief.src.tool, "codex");
	assert.equal(brief.src.sess, "thread-xyz");
	assert.ok(brief.tags.includes("tool:codex"));
});

test("inject:只有存在简报时才生成注入文本(无简报 0 token)", async () => {
	const { composeInjection, suggestedTagsFor, PROTOCOL_HINT } = await import("../src/inject.ts");
	assert.equal(composeInjection(""), undefined);
	assert.equal(composeInjection("   "), undefined);
	const text = composeInjection("简报集散地:1 条相关");
	assert.ok(text.startsWith(PROTOCOL_HINT));
	assert.match(text, /bh read <id>/);
	// 角色 -> 建议订阅标签
	assert.deepEqual(suggestedTagsFor("专管 github"), ["git", "sev:err"]);
	assert.deepEqual(suggestedTagsFor("电脑优化"), ["sev:err", "system"]);
	assert.ok(suggestedTagsFor("随便什么").includes("sev:err"), "错误标签总是建议订阅");
});

test("pi 订阅器:before_agent_start 返回自定义消息(把简报送进模型上下文)", async () => {
	const src = await (await import("node:fs/promises")).readFile(new URL("../extensions/brief-subscriber.ts", import.meta.url), "utf8");
	assert.match(src, /pi\.on\("before_agent_start"/, "必须挂在 before_agent_start 上");
	assert.match(src, /customType: "brief-hub"/, "以自定义消息形式注入");
	assert.match(src, /composeInjection/, "复用统一措辞");
	assert.match(src, /if \(!injected\) return;/, "无简报时不注入");
});

test("errorClass:瞬时噪声不投,任务级失败照投", async () => {
	const { errorClass } = await import("../src/errors.ts");
	for (const noise of ["unexpected EOF while looking for", "[object Object]", "--check 原 AGENTS.md", "/usr/bin/bash: -c: line 1: x", "短", "<stdin>:20: SyntaxWarning: invalid escape", "108: model.setCollapsed(ref, false); 637: private _fi", "[rtk] /!\ No hook installed", "Could not find edits[0] in F:/x", "Dangerous command blocked (no UI for confirmation)", "Found 3 occurrences of edits[1] in F:/x", "Error: Access denied: path F:/x", "Tool ctx_reduce not found"]) {
		assert.equal(errorClass(noise), "noise", `应为噪声:${noise}`);
	}
	assert.equal(errorClass("ENOENT: no such file or directory, open F:/x.txt"), "tool", "缺文件是工具级");
	for (const real of ["npm ERR! code ELIFECYCLE", "3 tests FAIL", "Traceback (most recent call last) 依赖缺失", "exit code 1: 构建失败"]) {
		assert.equal(errorClass(real), "task", `应为任务级:${real}`);
	}
});

test("composeInjection:摘要自带协议表头时不再叠加旧 hint(避免双表头)", async () => {
	const { composeInjection } = await import("../src/inject.ts");
	const withProtocol = "【简报集散地 brief-hub · 待你处理】x";
	assert.equal(composeInjection(withProtocol), withProtocol);
	assert.ok(composeInjection("简报集散地:1 条相关").startsWith("简报集散地 brief-hub:"));
});
