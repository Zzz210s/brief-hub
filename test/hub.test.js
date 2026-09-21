import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildBrief, clamp, dedupeKey, makeId } from "../src/brief.ts";
import { appendBrief, listBriefFiles, markConsumed, readAfter, readState, writeState, readSubscription, writeSubscription } from "../src/store.ts";
import { pollOnce } from "../src/inbox.ts";

/** 每个用例用独立 HOME,避免污染真实集散地 */
async function withTempHub(fn) {
	const dir = await mkdtemp(join(tmpdir(), "brief-hub-"));
	const previous = process.env.BRIEF_HUB_HOME_OVERRIDE;
	process.env.BRIEF_HUB_HOME_OVERRIDE = dir;
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete process.env.BRIEF_HUB_HOME_OVERRIDE;
		else process.env.BRIEF_HUB_HOME_OVERRIDE = previous;
	}
}

const snapshot = (overrides = {}) => ({
	sessionId: "sess-1",
	tool: "pi",
	sessionName: "专管 github",
	cwd: "E:/proj",
	repo: "Zzz210s/config-ai",
	changedPaths: ["config-ai/README.md"],
	commands: ["git push origin master"],
	...overrides,
});

test("buildBrief:推送场景生成 git.push 简报与相关标签,且不调用模型", () => {
	const brief = buildBrief(snapshot({ git: { pushed: true, summary: "3 个提交" } }), { now: 1_700_000_000_000, id: "b-test-0001" });
	assert.equal(brief.kind, "git.push");
	assert.match(brief.title, /推送/);
	assert.ok(brief.tags.includes("git.push"));
	assert.ok(brief.tags.includes("repo:Zzz210s/config-ai"));
	assert.equal(brief.id, "b-test-0001");
	assert.ok(brief.facts.length <= 3, "要点不超过 3 条");
	assert.ok(brief.title.length <= 60, "标题有界");
});

test("buildBrief:出错场景生成 task.error(高优先级)", () => {
	const brief = buildBrief(snapshot({ errorText: "pnpm ERR_PNPM_GLOBAL_BIN_DIR_NOT_IN_PATH", commands: ["pnpm install -g pi"] }));
	assert.equal(brief.kind, "task.error");
	assert.equal(brief.severity, "err");
	assert.ok(brief.tags.includes("sev:err"));
});

test("clamp/makeId/dedupeKey:有界与合并键", () => {
	assert.equal(clamp("a".repeat(100), 10).length, 10);
	assert.match(makeId(new Date("2026-09-21T00:00:00Z"), () => 0.5), /^b-20260921-[0-9a-f]{4}$/);
	const key1 = dedupeKey(snapshot(), "git.push");
	const key2 = dedupeKey(snapshot(), "git.push");
	assert.equal(key1, key2, "同类事件在同一时间片内合并");
});

test("存储:追加后可增量读取,游标按文件记录", async () => {
	await withTempHub(async () => {
		const brief = buildBrief(snapshot(), { id: "b-store-0001" });
		await appendBrief(brief);
		const files = await listBriefFiles(3);
		assert.equal(files.length, 1);
		const first = await readAfter(files[0], 0);
		assert.equal(first.briefs.length, 1);
		const second = await readAfter(files[0], first.offset);
		assert.equal(second.briefs.length, 0, "游标之后没有新内容");
	});
});

test("订阅与状态:读写往返 + 已读裁剪", async () => {
	await withTempHub(async () => {
		await writeSubscription({ sess: "me", tags: ["git"], delivery: "l1" });
		const sub = await readSubscription("me");
		assert.deepEqual(sub?.tags, ["git"]);
		await writeState("me", { cursors: {}, unread: ["a", "b"], consumed: [] });
		const state = await readState("me");
		const marked = markConsumed(state, ["a"]);
		assert.deepEqual(marked.consumed, ["a"]);
		assert.deepEqual(marked.unread, ["b"], "已读的从 unread 移除");
	});
});

test("pollOnce:首次只对齐游标(不投递历史),第二次才投递命中项并标记已读", async () => {
	await withTempHub(async () => {
		// 先塞一条"历史"简报
		await appendBrief(buildBrief(snapshot(), { id: "b-old-0001" }));
		await writeSubscription({ sess: "reader", tags: ["git"], delivery: "l1" });
		const first = await pollOnce("reader", { now: Date.now() });
		assert.equal(first.delivered, 0, "首次不投递历史");
		assert.match(first.reason ?? "", /首次运行/);

		// 再投一条新的:应命中并投递,且被标记已读
		await appendBrief(buildBrief(snapshot({ sessionName: "另一个会话" }), { id: "b-new-0001" }));
		const second = await pollOnce("reader", { now: Date.now() + 1000 });
		assert.equal(second.delivered, 1);
		assert.match(second.digest, /b-new-0001/);
		const state = await readState("reader");
		assert.ok(state.consumed.includes("b-new-0001"), "投递后立即写已读");

		// 第三次:同一条不再投递(用户要求:下次轮询不再检测)
		await appendBrief(buildBrief(snapshot({ sessionName: "第三个会话" }), { id: "b-new-0002" }));
		const third = await pollOnce("reader", { now: Date.now() + 2000 });
		assert.equal(third.delivered, 1);
		assert.match(third.digest, /b-new-0002/);
		assert.doesNotMatch(third.digest, /b-new-0001/, "已读的不再出现");
	});
});

test("pollOnce:无订阅时给出明确原因(不报错)", async () => {
	await withTempHub(async () => {
		const result = await pollOnce("nobody", { now: Date.now() });
		assert.equal(result.delivered, 0);
		assert.match(result.reason ?? "", /无订阅/);
	});
});
