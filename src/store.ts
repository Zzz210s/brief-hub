/**
 * 存储层:追加式 JSONL + 每消费者游标 + 已读标记 + 订阅 CRUD。
 *
 * 全部落在 ~/.ai-brief-hub/ 下的普通文件里:
 *   briefs/YYYY-MM-DD.jsonl   追加式简报(可 grep、崩溃安全)
 *   subs/<sess>.json          订阅
 *   state/<sess>.json         游标/未读/已读/预算
 *   config.json               全局配置(轮询间隔等)
 *
 * 读尾部是省 token 与省 IO 的关键:游标是字节偏移,没新增就一次读都不做。
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Brief } from "./schema.ts";

export function hubRoot(): string {
	return process.env.BRIEF_HUB_HOME_OVERRIDE || join(homedir(), ".ai-brief-hub");
}

export function subsDir(): string {
	return join(hubRoot(), "subs");
}

export function stateDir(): string {
	return join(hubRoot(), "state");
}

export function briefsDir(): string {
	return join(hubRoot(), "briefs");
}

/** 会话标识做文件名时做最小净化 */
export function safeName(sess: string): string {
	return sess.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "default";
}

/** 列出最近的简报文件(倒序),用于增量扫描 */
export async function listBriefFiles(limit = 3): Promise<string[]> {
	if (!existsSync(briefsDir())) return [];
	const files = (await readdir(briefsDir())).filter((name) => name.endsWith(".jsonl")).sort();
	return files.slice(-limit).map((name) => join(briefsDir(), name));
}

export function todayFile(date = new Date()): string {
	return join(briefsDir(), `${date.toISOString().slice(0, 10)}.jsonl`);
}

/** 追加一条简报 */
export async function appendBrief(brief: Brief): Promise<void> {
	await mkdir(briefsDir(), { recursive: true });
	await appendFile(todayFile(new Date(brief.ts)), JSON.stringify(brief) + "\n", "utf8");
}

/** 读取某天文件里 offset 之后的内容(返回简报与新的偏移) */
export async function readAfter(file: string, offset: number): Promise<{ briefs: Brief[]; offset: number; corrupted: number }> {
	if (!existsSync(file)) return { briefs: [], offset, corrupted: 0 };
	const raw = await readFile(file, "utf8");
	const slice = raw.slice(offset);
	const briefs: Brief[] = [];
	let corrupted = 0;
	for (const line of slice.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			briefs.push(JSON.parse(trimmed) as Brief);
		} catch {
			corrupted++;
		}
	}
	return { briefs, offset: raw.length, corrupted };
}

export { readSubscription, writeSubscription, listSubscriptions, readState, writeState, markConsumed, readConfig, writeConfig, hubStats, rebuildFanoutIndex, readFanoutIndex, maxFanoutFor, readRecentBriefs } from "./store-config.ts";
export type { HubConfig } from "./store-config.ts";
