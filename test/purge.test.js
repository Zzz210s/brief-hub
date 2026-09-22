import assert from "node:assert/strict";
import { test } from "node:test";
import { filterFromArgs, matchesFilter, selectForPurge, stripBriefs } from "../src/purge.ts";

const brief = (o = {}) => ({ id: "b1", ts: Date.now(), kind: "task.error", severity: "err", tags: ["git"], title: "任务出错: [object Object]", facts: [], artifacts: [], src: { sess: "s1", tool: "pi", name: "n", cwd: "E:/p" }, ttl: 86400, key: "k", ...o });

test("matchesFilter:按 kind/severity/时间/会话/正则/噪声 过滤", () => {
	const now = Date.now();
	const b = brief({ ts: now - 60_000 });
	assert.equal(matchesFilter(b, {}), true, "空条件命中全部");
	assert.equal(matchesFilter(b, { kind: "task.done" }), false);
	assert.equal(matchesFilter(b, { severity: "err" }), true);
	assert.equal(matchesFilter(b, { before: now - 120_000 }), false, "太新不命中");
	assert.equal(matchesFilter(b, { before: now }), true);
	assert.equal(matchesFilter(b, { fromSession: "other" }), false);
	assert.equal(matchesFilter(b, { pattern: "object" }), true);
	assert.equal(matchesFilter(b, { pattern: "[" }), false, "非法正则不命中(避免误清)");
	assert.equal(matchesFilter(b, { noiseOnly: true }), true, "[object Object] 属噪声");
	assert.equal(matchesFilter(brief({ title: "npm ERR! 构建失败" }), { noiseOnly: true }), false, "任务级失败不算噪声");
});

test("selectForPurge:批量挑选 id", () => {
	const now = Date.now();
	const list = [brief({ id: "a", ts: now - 1000 }), brief({ id: "b", ts: now - 1000, severity: "info", kind: "task.done", title: "完成" })];
	assert.deepEqual(selectForPurge(list, { severity: "err" }), ["a"]);
	assert.deepEqual(selectForPurge(list, {}).sort(), ["a", "b"]);
});

test("stripBriefs:从 JSONL 里剔除指定 id,保留其它行", () => {
	const text = ['{"id":"a","ts":1}', '{"id":"b","ts":2}', "半行", ""].join("\n");
	const result = stripBriefs(text, ["a"]);
	assert.equal(result.removed, 1);
	assert.ok(result.kept.includes('{"id":"b"'));
	assert.ok(!result.kept.includes('"a"'));
	assert.ok(result.kept.includes("半行"), "非 JSON 行原样保留");
});

test("filterFromArgs:命令行参数 -> 过滤器", () => {
	const f = filterFromArgs({ kind: "task.error", before: "2026-09-22", noise: true });
	assert.equal(f.kind, "task.error");
	assert.equal(typeof f.before, "number");
	assert.equal(f.noiseOnly, true);
	assert.equal(filterFromArgs({ before: "不是日期" }).before, undefined);
});
