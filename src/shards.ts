/**
 * 标签分片(tag shards):**一次写入,N 个读者读同一份**的共享快照。
 *
 * 动机:会话多起来后,如果每个订阅者都去扫"全量简报归档"再自己按标签过滤,
 * 就是 N 次重复过滤 + N 次重复 IO。这里把过滤**提前到写入时刻**:
 *   发布者写一次 -> shards/<标签>.jsonl(每条简报按它的标签链落到对应分片)
 *   订阅者只读自己关心的几个分片(同一标签的所有订阅者读的是**同一份文件**)
 *
 * 配合 mtime:分片文件未变化 -> 本轮连一次读都不做(见 shardsUnchanged)。
 *
 * 归档 briefs/*.jsonl 仍然保留(可 grep、可回放、计数不丢),分片只是索引层。
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir, open, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Brief } from "./schema.ts";
import { hubRoot } from "./store.ts";
import { tagChain } from "./tags.ts";

export function shardsDir(): string {
	return join(hubRoot(), "shards");
}

/** 分片文件名:标签里的 `/` 与 `:` 换成安全字符 */
export function shardFile(tag: string): string {
	return join(shardsDir(), `${tag.replace(/[^A-Za-z0-9_.-]/g, "_")}.jsonl`);
}

/**
 * 把一条简报写入它所有标签链上的分片(父标签也写,便于"订阅 git 命中 git.push")。
 * 返回写入的标签列表(供诊断)。
 */
export async function writeShards(brief: Brief): Promise<string[]> {
	const tags = new Set<string>();
	for (const tag of brief.tags ?? []) {
		for (const ancestor of tagChain(tag)) tags.add(ancestor);
	}
	if (tags.size === 0) return [];
	await mkdir(shardsDir(), { recursive: true });
	const line = JSON.stringify(brief) + "\n";
	for (const tag of tags) await appendFile(shardFile(tag), line, "utf8");
	return [...tags];
}

/** 只读 cursor 之后的部分(避免整文件读入内存) */
async function readFrom(file: string, cursor: number): Promise<string> {
	const info = await stat(file);
	const length = info.size - cursor;
	if (length <= 0) return "";
	const handle = await open(file, "r");
	try {
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, cursor);
		return buffer.toString("utf8");
	} finally {
		await handle.close();
	}
}

export interface ShardReadResult {
	briefs: Brief[];
	/** 新的游标:{分片绝对路径: 字节偏移} */
	cursors: Record<string, number>;
	/** 因文件未变化而完全跳过的分片数(0 读取) */
	skipped: number;
	/** 实际读取的字节数(衡量 IO) */
	bytesRead: number;
}

/**
 * 读订阅标签对应的分片增量。
 * - 文件 mtime/size 与上次相同 -> 跳过(不读)
 * - 否则从游标往后读
 */
export async function readShards(
	tags: string[],
	cursors: Record<string, number>,
	lastSeen: Record<string, { size: number; mtimeMs: number }> = {},
): Promise<ShardReadResult & { seen: Record<string, { size: number; mtimeMs: number }> }> {
	const briefs: Brief[] = [];
	const nextCursors: Record<string, number> = { ...cursors };
	const seen: Record<string, { size: number; mtimeMs: number }> = { ...lastSeen };
	let skipped = 0;
	let bytesRead = 0;

	for (const tag of tags) {
		const file = shardFile(tag);
		if (!existsSync(file)) continue;
		let info;
		try {
			info = await stat(file);
		} catch {
			continue;
		}
		const previous = lastSeen[file];
		const cursor = cursors[file] ?? 0;
		if (previous && previous.size === info.size && previous.mtimeMs === info.mtimeMs) {
			skipped++;
			continue;
		}
		seen[file] = { size: info.size, mtimeMs: info.mtimeMs };
		if (info.size <= cursor) {
			nextCursors[file] = info.size;
			continue;
		}
		const slice = await readFrom(file, cursor);
		bytesRead += Buffer.byteLength(slice, "utf8");
		for (const line of slice.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed.startsWith("{")) continue;
			try {
				briefs.push(JSON.parse(trimmed) as Brief);
			} catch {
				/* 半行跳过 */
			}
		}
		nextCursors[file] = info.size;
	}

	// 同一条简报可能落在多个分片(父子标签),按 id 去重
	const byId = new Map<string, Brief>();
	for (const brief of briefs) byId.set(brief.id, brief);
	return { briefs: [...byId.values()].sort((a, b) => a.ts - b.ts), cursors: nextCursors, skipped, bytesRead, seen };
}
