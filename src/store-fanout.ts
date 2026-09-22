import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULTS, type Brief, type SubState, type Subscription } from "./schema.ts";
import { hubRoot, listBriefFiles, safeName, subsDir, stateDir } from "./store.ts";

/**
 * 重新计算"每个标签的订阅者数量"。写订阅时调用(订阅很少变,代价低)。
 * 用途:auto 投递模式下,拥挤标签改为按小时合并,避免一条简报打扰 N 个会话。
 */
export async function rebuildFanoutIndex(): Promise<Record<string, number>> {
	const subs = await listSubscriptions();
	const counts: Record<string, number> = {};
	for (const sub of subs) {
		for (const tag of sub.tags ?? []) counts[tag] = (counts[tag] ?? 0) + 1;
	}
	await mkdir(join(hubRoot(), "index"), { recursive: true });
	await writeFile(fanoutFile(), JSON.stringify(counts), "utf8");
	return counts;
}

/** 读拥挤度索引(缺失时按空处理,不阻塞投递) */

export async function readFanoutIndex(): Promise<Record<string, number>> {
	try {
		return JSON.parse(await readFile(fanoutFile(), "utf8")) as Record<string, number>;
	} catch {
		return {};
	}
}

/** 一批标签里最大的订阅者数量(近似拥挤度) */

export function maxFanoutFor(tags: string[], index: Record<string, number>): number {
	let max = 0;
	for (const tag of tags) {
		const direct = index[tag];
		if (direct && direct > max) max = direct;
	}
	return max;
}

/* ---------- 有界读取:list 类命令不整文件扫描 ---------- */

/**
 * 从文件尾部读最多 maxBytes,返回解析出的简报(时间倒序)。
 * 用于 bh list / /hub list:简报累积后仍保持常量级 IO。
 */
