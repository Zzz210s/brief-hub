import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFER_RESURFACE_MS, classify, groupPending, handlingStats, renderProtocol, shouldSurface } from "../src/handling.ts";

const brief = (o = {}) => ({ id: "b1", ts: Date.now(), kind: "task.done", severity: "info", tags: ["git"], title: "t", facts: [], artifacts: [], src: { sess: "s", tool: "pi", name: "n", cwd: "E:/p" }, ttl: 86400, key: "k", ...o });
const sub = (o = {}) => ({ sess: "me", tags: ["git"], ...o });

test("classify:错误与点名必须处理,精确命中需核对,父级命中仅供参考", () => {
	assert.equal(classify(brief({ severity: "err" }), sub()), "act");
	assert.equal(classify(brief({ tags: ["sess:me"] }), sub()), "act");
	assert.equal(classify(brief({ action: "git status" }), sub()), "act");
	assert.equal(classify(brief({ tags: ["git"] }), sub()), "check");
	assert.equal(classify(brief({ tags: ["git.push"], severity: "warn" }), sub()), "fyi");
	assert.equal(classify(brief({ tags: ["repo:a/b"] }), sub({ tags: ["repo"], repos: ["a/b"] })), "check");
});

test("shouldSurface:已处理不再浮现;延迟未到不浮现,到期重新提醒", () => {
	const now = Date.now();
	assert.equal(shouldSurface(brief(), {}, now), true);
	assert.equal(shouldSurface(brief(), { handled: { b1: now } }, now), false, "处理过的不再浮现");
	assert.equal(shouldSurface(brief(), { deferred: { b1: now - 1000 } }, now), false, "延迟中不浮现");
	assert.equal(shouldSurface(brief(), { deferred: { b1: now - DEFER_RESURFACE_MS - 1 } }, now), true, "到期后重新提醒");
});

test("renderProtocol:输出处理步骤 + 按优先级分组 + 控制展开条数", () => {
	const items = [
		{ brief: brief({ id: "a1", severity: "err", title: "错误简报" }), action: "act" },
		{ brief: brief({ id: "c1", title: "核对简报" }), action: "check" },
		{ brief: brief({ id: "f1", title: "参考简报" }), action: "fyi" },
	];
	const text = renderProtocol(items);
	assert.match(text, /待你处理/);
	assert.match(text, /bh handle <id>/);
	assert.match(text, /不要只回复编号/, "必须明确禁止敷衍回复");
	assert.match(text, /必须处理\(1\)/);
	assert.match(text, /需要核对\(1\)/);
	assert.ok(text.indexOf("必须处理") < text.indexOf("需要核对"), "act 排在前面");
	assert.match(text, /a1/);
	assert.equal(renderProtocol([]), undefined, "无待处理 -> 不注入(0 token)");
});

test("groupPending/handlingStats:分组与统计", () => {
	const items = [{ brief: brief({ id: "x" }), action: "act" }, { brief: brief({ id: "y" }), action: "fyi" }];
	const groups = groupPending(items);
	assert.equal(groups.act.length, 1);
	assert.equal(groups.fyi.length, 1);
	const stats = handlingStats({ handled: { a: 1 }, deferred: { b: Date.now() - DEFER_RESURFACE_MS - 1 } }, Date.now());
	assert.equal(stats.handled, 1);
	assert.equal(stats.deferredDue, 1);
});
