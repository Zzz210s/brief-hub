import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULTS, type Brief, type SubState, type Subscription } from "./schema.ts";
import { hubRoot, listBriefFiles, safeName, subsDir, stateDir } from "./store.ts";

export async function readRecentBriefs(files: string[], maxBytes: number, limit: number): Promise<Brief[]> {
	const out: Brief[] = [];
	for (const file of [...files].reverse()) {
		if (out.length >= limit) break;
		let raw = "";
		try {
			const info = await stat(file);
			const start = Math.max(0, info.size - maxBytes);
			const handle = await open(file, "r");
			try {
				const length = info.size - start;
				const buffer = Buffer.alloc(Number(length));
				await handle.read(buffer, 0, Number(length), start);
				raw = buffer.toString("utf8");
			} finally {
				await handle.close();
			}
		} catch {
			continue;
		}
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed.startsWith("{")) continue; // 截断产生的半行
			try {
				out.push(JSON.parse(trimmed) as Brief);
			} catch {
				/* 半行跳过 */
			}
		}
	}
	return out.sort((a, b) => b.ts - a.ts).slice(0, limit);
}
