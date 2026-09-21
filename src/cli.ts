#!/usr/bin/env node
/**
 * bh — 简报集散地 CLI
 *
 * 用法:
 *   bh publish --tool pi --sess <id> --name <会话名> --cwd <目录> [--repo owner/name]
 *              [--changed <路径>]... [--command <命令>]... [--error <文本>] [--title <标题>]
 *   bh list [--unread] [--limit N] [--json]
 *   bh read <id>
 *   bh sub add <标签>... [--sess <会话>] [--delivery l1|l2|off] [--budget N] [--quiet 23-7]
 *   bh sub list | bh sub rm <标签>...
 *   bh poll [--sess <会话>] [--force] [--json]     # 消费者轮询(pi 扩展也用它)
 *   bh status [--json]
 *   bh tag <标签>...                                # 打印自动推导结果(调试用)
 */

import { readFile } from "node:fs/promises";
import { one, parseArgs, publishFromTranscript, readAllBriefs } from "./cli-support.ts";
import { buildBrief, clamp } from "./brief.ts";
import { defaultSub, pollOnce } from "./inbox.ts";
import { renderBrief } from "./match.ts";
import { deriveTags } from "./tags.ts";
import {
	appendBrief,
	hubStats,
	listBriefFiles,
	listSubscriptions,
	readAfter,
	readSubscription,
	readState,
	writeSubscription,
	safeName,
	markConsumed,
	writeState,
} from "./store.ts";
import type { Brief, Subscription } from "./schema.ts";

async function run(): Promise<void> {
	const argv = process.argv.slice(2);
	const args = parseArgs(argv);
	const sess = one(args.flags, "sess");

	switch (args.command) {
		case "publish": {
			const snapshot = {
				sessionId: one(args.flags, "sess-id") ?? sess ?? `cli-${process.pid}`,
				tool: one(args.flags, "tool") ?? "cli",
				sessionName: one(args.flags, "name") ?? "cli",
				cwd: one(args.flags, "cwd") ?? process.cwd(),
				repo: one(args.flags, "repo"),
				changedPaths: args.flags.changed ?? [],
				commands: args.flags.command ?? [],
				errorText: one(args.flags, "error"),
				finalMessage: one(args.flags, "message"),
				git: args.bool.has("pushed") ? { pushed: true, summary: one(args.flags, "summary") } : args.bool.has("committed") ? { committed: true, summary: one(args.flags, "summary") } : undefined,
			};
			const brief = buildBrief(snapshot);
			if (one(args.flags, "title")) brief.title = clamp(one(args.flags, "title")!, 60);
			await appendBrief(brief);
			console.log(args.bool.has("json") ? JSON.stringify(brief) : `已投稿 ${brief.id} [${brief.kind}] ${brief.title}`);
			return;
		}
		case "poll": {
			if (!sess) throw new Error("poll 需要 --sess <会话>");
			const result = await pollOnce(sess, { force: args.bool.has("force") });
			if (args.bool.has("json")) {
				console.log(JSON.stringify({ sess: result.sess, delivered: result.delivered, reason: result.reason, digest: result.digest }));
				return;
			}
			if (result.digest) console.log(result.digest);
			else console.log(`(无投递: ${result.reason ?? "无新简报"})`);
			return;
		}
		case "list": {
			const files = await listBriefFiles(7);
			let briefs = await readAllBriefs(files);
			const state = sess ? await readState(sess) : undefined;
			if (args.bool.has("unread")) {
				const unread = new Set(state?.unread ?? []);
				briefs = briefs.filter((brief) => unread.has(brief.id));
			}
			const limit = Number(one(args.flags, "limit") ?? 20);
			const sliced = briefs.slice(0, limit);
			if (args.bool.has("json")) {
				console.log(JSON.stringify(sliced, null, "\t"));
				return;
			}
			if (!sliced.length) {
				console.log("(无简报)");
				return;
			}
			for (const brief of sliced) {
				const mark = state?.consumed?.includes(brief.id) ? "已读" : "未读";
				console.log(`${mark} ${brief.id}  [${brief.kind}] ${brief.title}  (${brief.tags.filter((tag) => !tag.startsWith("tool:")).slice(0, 3).join(",")})`);
			}
			return;
		}
		case "read": {
			const id = args.rest[0];
			if (!id) throw new Error("用法: bh read <id>");
			const files = await listBriefFiles(7);
			const brief = (await readAllBriefs(files)).find((item) => item.id === id);
			if (!brief) throw new Error(`未找到简报 ${id}`);
			console.log(args.bool.has("json") ? JSON.stringify(brief, null, "\t") : renderBrief(brief));
			if (sess) {
				const state = await readState(sess);
				await writeState(sess, markConsumed(state, [brief.id]));
			}
			return;
		}
		case "sub": {
			const action = args.rest[0];
			if (!sess) throw new Error("sub 需要 --sess <会话>");
			const existing = (await readSubscription(sess)) ?? defaultSub(sess, []);
			if (action === "list" || (!action && sess)) {
				const subs = action === "list" && !one(args.flags, "sess") ? await listSubscriptions() : [existing];
				for (const sub of subs) console.log(`${sub.sess}: [${sub.tags.join(", ")}] delivery=${sub.delivery ?? "l1"} budget=${sub.budgetPerHour ?? "-"} quiet=${sub.quietHours ?? "-"}`);
				return;
			}
			if (action === "add") {
				const tags = new Set([...existing.tags, ...args.rest.slice(1)]);
				const quiet = one(args.flags, "quiet");
				const sub: Subscription = {
					...existing,
					tags: [...tags].sort(),
					delivery: (one(args.flags, "delivery") as Subscription["delivery"]) ?? existing.delivery ?? "l1",
					budgetPerHour: one(args.flags, "budget") ? Number(one(args.flags, "budget")) : existing.budgetPerHour,
					quietHours: quiet ? (quiet.split("-").map(Number) as [number, number]) : existing.quietHours,
					repos: args.flags.repo ? [...(existing.repos ?? []), ...args.flags.repo] : existing.repos,
				};
				await writeSubscription(sub);
				console.log(`订阅已更新 ${safeName(sess)}: [${sub.tags.join(", ")}]`);
				return;
			}
			if (action === "rm") {
				const drop = new Set(args.rest.slice(1));
				const sub = { ...existing, tags: existing.tags.filter((tag) => !drop.has(tag)) };
				await writeSubscription(sub);
				console.log(`订阅已更新 ${safeName(sess)}: [${sub.tags.join(", ")}]`);
				return;
			}
			throw new Error("用法: bh sub add|list|rm ...");
		}
		case "tag": {
			const tags = deriveTags({
				tool: one(args.flags, "tool") ?? "pi",
				sessionName: one(args.flags, "name") ?? "",
				cwd: one(args.flags, "cwd") ?? process.cwd(),
				repo: one(args.flags, "repo"),
				changedPaths: args.flags.changed ?? [],
				commands: args.rest,
			});
			console.log(tags.join(" "));
			return;
		}
		case "digest": {
			if (!sess) throw new Error("digest 需要 --sess <会话>");
			const result = await pollOnce(sess, { force: args.bool.has("force") });
			if (result.digest) console.log(result.digest);
			else if (args.bool.has("json")) console.log(JSON.stringify({ delivered: 0, reason: result.reason }));
			return;
		}
		case "publish-from": {
			// 跨 harness 补投:从别的工具的会话文件推导简报(见 cli-support.ts)
			const path = args.rest[0];
			if (!path) throw new Error("用法: bh publish-from <会话文件> [--harness claude] [--name <会话名>]");
			console.log(await publishFromTranscript({ path, harness: one(args.flags, "harness"), sessionId: one(args.flags, "sess-id"), name: one(args.flags, "name"), repo: one(args.flags, "repo") }));
			return;
		}
		case "status": {
			const stats = await hubStats();
			if (args.bool.has("json")) {
				console.log(JSON.stringify(stats, null, "\t"));
				return;
			}
			console.log(`简报总数(近 7 天): ${stats.briefs}`);
			console.log(`订阅数: ${stats.subs}`);
			console.log(`最近投稿: ${stats.lastBriefAt ? new Date(stats.lastBriefAt).toLocaleString() : "无"}`);
			for (const consumer of stats.consumers) {
				console.log(`  消费者 ${consumer.sess}: 未读 ${consumer.unread} · 已读 ${consumer.consumed} · 本小时预算用量 ${consumer.budgetUsed}`);
			}
			return;
		}
		case "help":
		case "":
			console.log(await readFile(new URL("./cli-help.txt", import.meta.url), "utf8").catch(() => "用法见 README"));
			return;
		default:
			throw new Error(`未知命令: ${args.command}(bh help 查看用法)`);
	}
}

run().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
