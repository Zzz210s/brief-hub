/**
 * 存储层(第二部分):订阅、消费者状态、全局配置与健康统计。
 * 与 store.ts 分开是为了守住单文件 200 行上限。
 */

import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULTS, type Brief, type SubState, type Subscription } from "./schema.ts";
import { hubRoot, listBriefFiles, safeName, subsDir, stateDir } from "./store.ts";

export async function readSubscription(sess: string): Promise<Subscription | undefined> {
	const file = join(subsDir(), `${safeName(sess)}.json`);
	if (!existsSync(file)) return undefined;
	try {
		return JSON.parse(await readFile(file, "utf8")) as Subscription;
	} catch {
		return undefined;
	}
}

export async function writeSubscription(sub: Subscription): Promise<void> {
	await mkdir(subsDir(), { recursive: true });
	const file = join(subsDir(), `${safeName(sub.sess)}.json`);
	const tmp = `${file}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(sub, null, "\t"), "utf8");
	await rename(tmp, file);
	// 订阅变化 → 刷新拥挤度索引(供 auto 投递模式判断是否改为按小时合并)
	try {
		await rebuildFanoutIndex();
	} catch {
		/* 索引失败不影响订阅本身 */
	}
}

export async function listSubscriptions(): Promise<Subscription[]> {
	if (!existsSync(subsDir())) return [];
	const out: Subscription[] = [];
	for (const name of await readdir(subsDir())) {
		if (!name.endsWith(".json")) continue;
		try {
			out.push(JSON.parse(await readFile(join(subsDir(), name), "utf8")) as Subscription);
		} catch {
			/* 跳过损坏的订阅 */
		}
	}
	return out;
}

export async function readState(sess: string): Promise<SubState> {
	const file = join(stateDir(), `${safeName(sess)}.json`);
	if (!existsSync(file)) return { cursors: {}, unread: [], consumed: [] };
	try {
		return JSON.parse(await readFile(file, "utf8")) as SubState;
	} catch {
		return { cursors: {}, unread: [], consumed: [] };
	}
}

export async function writeState(sess: string, state: SubState): Promise<void> {
	await mkdir(stateDir(), { recursive: true });
	const file = join(stateDir(), `${safeName(sess)}.json`);
	const tmp = `${file}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(state), "utf8");
	await rename(tmp, file);
}

/** 标记已读:写 consumed 并裁剪窗口(避免无限增长) */
export function markConsumed(state: SubState, ids: string[], now = Date.now()): SubState {
	const consumedAt = state.consumedAt ?? {};
	for (const id of ids) consumedAt[id] = now;
	const cutoff = now - DEFAULTS.consumedWindowMs;
	const kept = Object.entries(consumedAt).filter(([, at]) => at >= cutoff);
	kept.sort((a, b) => b[1] - a[1]);
	const limited = kept.slice(0, 2000);
	return {
		...state,
		consumed: limited.map(([id]) => id),
		consumedAt: Object.fromEntries(limited),
		unread: (state.unread ?? []).filter((id) => !ids.includes(id)),
	};
}

export interface HubConfig {
	pollMs?: number;
	coalesceMs?: number;
	enabled?: boolean;
	quietHours?: [number, number];
}

export async function readConfig(): Promise<HubConfig> {
	const file = join(hubRoot(), "config.json");
	if (!existsSync(file)) return {};
	try {
		return JSON.parse(await readFile(file, "utf8")) as HubConfig;
	} catch {
		return {};
	}
}

export async function writeConfig(config: HubConfig): Promise<void> {
	await mkdir(hubRoot(), { recursive: true });
	const file = join(hubRoot(), "config.json");
	const tmp = `${file}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(config, null, "\t"), "utf8");
	await rename(tmp, file);
}

/** 健康检查数据(供 bh status / doctor) */
export async function hubStats(): Promise<{
	briefs: number;
	subs: number;
	consumers: { sess: string; cursor: number; unread: number; consumed: number; budgetUsed: number }[];
	lastBriefAt?: number;
}> {
	const files = await listBriefFiles(7);
	let briefs = 0;
	let lastBriefAt: number | undefined;
	for (const file of files) {
		const raw = await readFile(file, "utf8").catch(() => "");
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			briefs++;
			try {
				const parsed = JSON.parse(line) as Brief;
				if (!lastBriefAt || parsed.ts > lastBriefAt) lastBriefAt = parsed.ts;
			} catch {
				/* 忽略 */
			}
		}
	}
	const subs = await listSubscriptions();
	const consumers: { sess: string; cursor: number; unread: number; consumed: number; budgetUsed: number }[] = [];
	const known = new Set(subs.map((sub) => sub.sess));
	if (existsSync(stateDir())) {
		for (const name of await readdir(stateDir())) {
			if (name.endsWith(".json")) known.add(name.replace(/\.json$/, ""));
		}
	}
	for (const sess of known) {
		const state = await readState(sess);
		const hourStart = Math.floor(Date.now() / 3_600_000) * 3_600_000;
		consumers.push({
			sess,
			cursor: Object.values(state.cursors ?? {}).reduce((sum, value) => sum + value, 0),
			unread: state.unread.length,
			consumed: state.consumed.length,
			budgetUsed: state.budget?.hourStart === hourStart ? state.budget.used : 0,
		});
	}
	return { briefs, subs: subs.length, consumers, lastBriefAt };
}

/* ---------- 拥挤度索引(fanout):会话多起来时的节流依据 ---------- */

function fanoutFile(): string {
	return join(hubRoot(), "index", "fanout.json");
}

export { rebuildFanoutIndex, readFanoutIndex, maxFanoutFor } from "./store-fanout.ts";
export { readRecentBriefs } from "./store-read.ts";
