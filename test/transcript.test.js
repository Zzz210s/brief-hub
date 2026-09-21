import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyState, parseClaudeTranscript, recordFailure, recordToolCall, snapshotFromState, toolCallFromHook } from "../src/transcript.ts";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("recordToolCall:累积改动路径与命令(有界、去重)", () => {
	let state = emptyState({ sessionId: "s", harness: "claude", cwd: "E:/p" });
	state = recordToolCall(state, "Edit", { file_path: "a/b.ts" });
	state = recordToolCall(state, "Edit", { file_path: "a/b.ts" });
	state = recordToolCall(state, "Bash", { command: "git   push origin master" });
	assert.deepEqual(state.changedPaths, ["a/b.ts"], "同路径去重");
	assert.deepEqual(state.commands, ["git push origin master"], "命令空白折叠");
});

test("snapshotFromState:识别 git push 并生成对应 git 字段", () => {
	const state = recordToolCall(emptyState({ sessionId: "s", harness: "claude", cwd: "E:/p" }), "Bash", { command: 'git commit -m "修 bug"' });
	state.commands.push("git push origin master");
	const snapshot = snapshotFromState(state);
	assert.equal(snapshot.git?.pushed, true);
	assert.equal(snapshot.git?.summary, "修 bug");
	assert.equal(snapshot.tool, "claude");
});

test("recordFailure:错误被记录为 task.error 的依据", () => {
	const state = recordFailure(emptyState({ sessionId: "s", harness: "claude" }), "boom");
	assert.equal(state.errorText, "boom");
});

test("toolCallFromHook:兼容 tool_name/tool_input 命名", () => {
	const call = toolCallFromHook({ tool_name: "Write", tool_input: { file_path: "x.ts" } });
	assert.deepEqual(call, { toolName: "Write", input: { file_path: "x.ts" } });
	assert.equal(toolCallFromHook({}), undefined);
});

test("parseClaudeTranscript:从真实形状的 JSONL 抽事实", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bh-transcript-"));
	const file = join(dir, "s.jsonl");
	const lines = [
		JSON.stringify({ type: "user", cwd: "E:/proj", message: { role: "user", content: "改一下配置" } }),
		JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
			{ type: "text", text: "我来改" },
			{ type: "tool_use", name: "Edit", input: { file_path: "config-ai/settings.json" } },
			{ type: "tool_use", name: "Bash", input: { command: "git push origin master" } },
		] } }),
	];
	await writeFile(file, lines.join("\n") + "\n", "utf8");
	const parsed = await parseClaudeTranscript(file);
	assert.equal(parsed.cwd, "E:/proj");
	assert.deepEqual(parsed.changedPaths, ["config-ai/settings.json"]);
	assert.deepEqual(parsed.commands, ["git push origin master"]);
	assert.equal(parsed.finalMessage, "我来改");
});
