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
