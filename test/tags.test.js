import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveTags, scoreBrief, tagChain, tagsIntersect } from "../src/tags.ts";

test("tagChain:层级展开(领域/仓库/命名空间)", () => {
	assert.deepEqual(tagChain("git.push"), ["git.push", "git"]);
	assert.deepEqual(tagChain("repo:Zzz210s/config-ai"), ["repo:Zzz210s/config-ai", "repo:Zzz210s/*", "repo"]);
	assert.deepEqual(tagChain("sev:err"), ["sev:err", "sev"]);
	assert.deepEqual(tagChain("plain"), ["plain"]);
});

test("tagsIntersect:父级订阅能命中子标签(0 token 硬过滤)", () => {
	assert.equal(tagsIntersect(["git"], ["git.push"]), true, "订阅 git 命中 git.push");
	assert.equal(tagsIntersect(["repo"], ["repo:a/b"]), true, "订阅 repo 命中具体仓库");
	assert.equal(tagsIntersect(["config"], ["git.push"]), false);
	assert.equal(tagsIntersect([], ["git"]), false, "空订阅永不命中");
});

test("scoreBrief:精确命中高于父级命中,严重错误加权", () => {
	const base = { ts: Date.now(), src: { cwd: "E:/proj" }, severity: "info" };
	const exact = scoreBrief({ sess: "s", tags: ["git.push"] }, { ...base, tags: ["git.push"] }, { now: Date.now() });
	const parent = scoreBrief({ sess: "s", tags: ["git"] }, { ...base, tags: ["git.push"] }, { now: Date.now() });
	assert.equal(exact, 2, "精确命中 2.0");
	assert.equal(parent, 1, "父级命中 1.0(= 默认门槛)");
	const err = scoreBrief({ sess: "s", tags: ["git"] }, { ...base, tags: ["git.push"], severity: "err" }, { now: Date.now() });
	assert.equal(err, 1.5, "错误加权 +0.5");
});

test("scoreBrief:陈旧简报降权(24 小时最多扣 1.0)", () => {
	const now = Date.now();
	const brief = { ts: now - 36 * 3600_000, src: { cwd: "E:/p" }, tags: ["git"], severity: "info" };
	assert.equal(scoreBrief({ sess: "s", tags: ["git"] }, brief, { now }), 1, "两倍窗口后扣满 1.0 后仍可为 1(2-1)");
});

test("scoreBrief:同仓库/同目录/亲和加权", () => {
	const now = Date.now();
	const brief = { ts: now, src: { cwd: "E:/proj/sub" }, tags: ["repo:a/b"], severity: "info" };
	const score = scoreBrief({ sess: "s", tags: ["git"], repos: ["a/b"], cwds: ["E:/proj"] }, brief, { now });
	assert.equal(score, 0, "标签不交集 -> 0(亲和不能凭空命中)");
	const score2 = scoreBrief({ sess: "s", tags: ["repo"], repos: ["a/b"], cwds: ["E:/other"] }, brief, { now });
	assert.equal(score2, 1.5, "父级 1.0 + 同仓库亲和 0.5(目录不匹配不加)");
	const score3 = scoreBrief({ sess: "s", tags: ["repo"], cwds: ["E:/proj"] }, brief, { now });
	assert.equal(score3, 1.5, "父级 1.0 + 同目录亲和 0.5");
});

test("deriveTags:从工具/命令/改动路径/会话名自动推导", () => {
	const tags = deriveTags({
		tool: "pi",
		sessionName: "专管 github 的会话",
		cwd: "E:/proj/config-ai",
		repo: "Zzz210s/config-ai",
		changedPaths: ["config-ai/tools/claude/settings.json", "pkg/package.json"],
		commands: ["git push origin master", "pnpm install"],
		kind: "task.done",
	});
	for (const expected of ["tool:pi", "sev:info", "task.done", "proj:config-ai", "repo:Zzz210s/config-ai", "config", "deps", "git", "git.push"]) {
		assert.ok(tags.includes(expected), `应含标签 ${expected}(实际: ${tags.join(" ")})`);
	}
});
