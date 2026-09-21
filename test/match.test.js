import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateTokens, inQuietHours, planDelivery, renderDigest } from "../src/match.ts";
import { DEFAULTS } from "../src/schema.ts";

const brief = (overrides = {}) => ({
	id: "b-1",
	ts: Date.now(),
	kind: "git.push",
	severity: "info",
	src: { sess: "s1", tool: "pi", name: "会话", cwd: "E:/p" },
	tags: ["git", "git.push"],
	title: "推送 3 个提交",
	facts: [],
	artifacts: [],
	ttl: DEFAULTS.ttlSeconds,
	key: "k1",
	...overrides,
});

const sub = (overrides = {}) => ({ sess: "me", tags: ["git"], delivery: "l1", ...overrides });
const state = (overrides = {}) => ({ cursors: {}, unread: [], consumed: [], ...overrides });

test("planDelivery:无标签交集 -> 空计划(零注入)", () => {
	const plan = planDelivery({ incoming: [brief({ tags: ["system"] })], sub: sub(), state: state(), now: Date.now() });
	assert.equal(plan.items.length, 0);
	assert.equal(plan.estimatedTokens, 0);
	assert.equal(renderDigest(plan), "", "无命中时不应产生任何可注入文本");
	assert.equal(plan.reason, "无命中");
});

test("planDelivery:已读简报不再投递(下次轮询不再检测)", () => {
	const target = brief();
	const plan = planDelivery({ incoming: [target], sub: sub(), state: state({ consumed: [target.id] }), now: Date.now() });
	assert.equal(plan.items.length, 0);
});

test("planDelivery:过期简报不投递", () => {
	const old = brief({ ts: Date.now() - (DEFAULTS.ttlSeconds + 10) * 1000 });
	const plan = planDelivery({ incoming: [old], sub: sub(), state: state(), now: Date.now() });
	assert.equal(plan.items.length, 0);
});

test("planDelivery:父级订阅恰好达标投递(门槛 1.0)", () => {
	const plan = planDelivery({ incoming: [brief()], sub: sub(), state: state(), now: Date.now() });
	assert.equal(plan.items.length, 1);
	assert.equal(plan.items[0].score, 2, "git 精确命中为 2.0");
});

test("planDelivery:同去重键在窗口内合并为一条(20 次推送 -> 1 条)", () => {
	const now = Date.now();
	const many = Array.from({ length: 20 }, (_, i) => brief({ id: `b-${i}`, key: "same", ts: now - i * 1000, facts: [`事实 ${i}`] }));
	const plan = planDelivery({ incoming: many, sub: sub(), state: state(), now });
	assert.equal(plan.items.length, 1, "合并为 1 条");
	assert.equal(plan.items[0].mergedFrom?.length, 20, "记录 20 个成员 id");
	assert.equal(plan.matchedIds.length, 20, "全部命中 id 都保留(供诊断)");
});

test("planDelivery:预算用尽时只给未展开计数", () => {
	const now = Date.now();
	const briefs = Array.from({ length: 5 }, (_, i) => brief({ id: `b-${i}`, key: `k${i}`, ts: now - i * 1000, title: `长标题${"x".repeat(40)}${i}` }));
	const plan = planDelivery({ incoming: briefs, sub: sub({ budgetPerHour: 40 }), state: state(), now });
	assert.ok(plan.items.length >= 1, "至少投一条");
	assert.ok(plan.suppressed >= 1, "余下被压下");
	const digest = renderDigest(plan);
	assert.match(digest, /另有 \d+ 条未展开/, "摘要里给出计数");
});

test("planDelivery:静默时段与关闭状态不投递", () => {
	const now = new Date("2026-09-21T23:30:00").getTime();
	const quiet = planDelivery({ incoming: [brief()], sub: sub({ quietHours: [23, 7] }), state: state(), now });
	assert.equal(quiet.items.length, 0);
	assert.equal(quiet.reason, "静默时段");
	const off = planDelivery({ incoming: [brief()], sub: sub({ delivery: "off" }), state: state(), now: Date.now() });
	assert.equal(off.reason, "订阅已关闭");
});

test("inQuietHours:支持跨零点", () => {
	assert.equal(inQuietHours(23, [23, 7]), true);
	assert.equal(inQuietHours(3, [23, 7]), true);
	assert.equal(inQuietHours(12, [23, 7]), false);
	assert.equal(inQuietHours(9, [9, 9]), false, "起止相同视为不静默");
});

test("estimateTokens:标题级投递成本很低(单条 < 40 token)", () => {
	const cost = estimateTokens(brief({ title: "config-ai 推送 3 个提交" }));
	assert.ok(cost > 0 && cost < 40, `实际 ${cost}`);
});

test("fanout 节流:订阅者多时 auto 模式改为按小时合并,错误与点名仍立即", () => {
	const now = Date.now();
	const baseSub = sub(); // mode 未声明 = auto
	const briefs = Array.from({ length: 10 }, (_, i) => brief({ id: `b-${i}`, key: `k${i}`, ts: now - i * 1000 }));
	// 拥挤(fanout 8 ≥ 阈值 4):首次投递应合并成一条摘要(只展开前 3 条)
	const crowded = planDelivery({ incoming: briefs, sub: baseSub, state: state(), now, fanout: 8 });
	assert.equal(crowded.items.length, 10, "10 条都在计划里(不丢)");
	const digest = renderDigest(crowded);
	assert.ok(digest.split("\n").length <= 6, `摘要行数应被压缩(实际 ${digest.split("\n").length} 行)`);
	assert.match(digest, /另有 \d+ 条未展开/);

	// 未到点(刚投递过):本轮不注入任何内容,条目保留为未读
	const justDelivered = { ...state(), lastDeliveryAt: now - 60_000 };
	const throttled = planDelivery({ incoming: briefs, sub: baseSub, state: justDelivered, now, fanout: 8 });
	assert.equal(throttled.items.length, 0);
	assert.equal(throttled.estimatedTokens, 0);
	assert.equal(throttled.matchedIds.length, 10, "仍记录命中,保留未读");
	assert.match(throttled.reason ?? "", /合并投递未到点/);

	// 紧急(错误/点名)不受节流影响
	const errors = briefs.map((b, i) => ({ ...b, severity: i === 0 ? "err" : "info", tags: [...b.tags, i === 0 ? "sev:err" : "x"] }));
	const urgentPlan = planDelivery({ incoming: errors, sub: baseSub, state: justDelivered, now, fanout: 8 });
	assert.equal(urgentPlan.items.length, 1, "只立即投紧急项");
	assert.ok(urgentPlan.estimatedTokens > 0);
});
