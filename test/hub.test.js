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

test("peek:只窥视不消费 —— 简报不会被状态徽标吃掉", async () => {
	await withTempHub(async () => {
		await appendBrief(buildBrief(snapshot(), { id: "b-peek-0001" }));
		await writeSubscription({ sess: "peeker", tags: ["git"], delivery: "l1" });
		await pollOnce("peeker", { now: Date.now() }); // 首轮对齐
		await appendBrief(buildBrief(snapshot({ sessionName: "另一会话" }), { id: "b-peek-0002" }));
		const peeked = await pollOnce("peeker", { now: Date.now() + 1000, peek: true });
		assert.equal(peeked.delivered, 1, "窥视能看到 1 条");
		assert.match(peeked.digest, /b-peek-0002/);
		const state = await readState("peeker");
		assert.equal(state.consumed.includes("b-peek-0002"), false, "窥视不得标已读");
		// 真正投递(非 peek)时才消费
		const real = await pollOnce("peeker", { now: Date.now() + 2000 });
		assert.equal(real.delivered, 1, "非窥视仍能投递同一条(未被吃掉)");
		assert.match(real.digest, /b-peek-0002/);
		const after = await readState("peeker");
		assert.ok(after.consumed.includes("b-peek-0002"), "真正注入后才标已读");
	});
});

test("自简报抑制:会话不会收到自己刚投的简报", async () => {
	await withTempHub(async () => {
		await writeSubscription({ sess: "self", tags: ["git"], delivery: "l1" });
		await pollOnce("self", { now: Date.now() }); // 对齐
		// 自己投的
		await appendBrief(buildBrief(snapshot({ sessionId: "self", sessionName: "self" }), { id: "b-self-0001" }));
		// 别人投的
		await appendBrief(buildBrief(snapshot({ sessionId: "other", sessionName: "other" }), { id: "b-other-0001" }));
		const result = await pollOnce("self", { now: Date.now() + 1000 });
		assert.ok(!result.digest.includes("b-self-0001"), "不得出现自简报");
		assert.ok(result.digest.includes("b-other-0001"), "别人的简报照常");
	});
});

test("协议只发一次:第二次注入用精简表头(省 token)", async () => {
	await withTempHub(async () => {
		await writeSubscription({ sess: "c", tags: ["git"], delivery: "l1" });
		await pollOnce("c", { now: Date.now() });
		await appendBrief(buildBrief(snapshot({ sessionId: "x" }), { id: "b-p-0001" }));
		const first = await pollOnce("c", { now: Date.now() + 1000 });
		assert.match(first.digest, /【简报集散地/, "首次给完整协议");
		await appendBrief(buildBrief(snapshot({ sessionId: "y" }), { id: "b-p-0002" }));
		const second = await pollOnce("c", { now: Date.now() + 2000 });
		assert.match(second.digest, /处理协议见你的指令文件/, "之后精简");
		assert.ok(!second.digest.includes("不要只回复编号"), "不再重复整段协议");
	});
});
