import { readAfter } from "./store.ts";
import { join } from "node:path";
import type { Brief } from "./schema.ts";

export async function orphansFor(now = Date.now(), limit = 12): Promise<string> {
	const [{ listBriefFiles, readState, listSubscriptions }, { readRecentBriefs }, schema, fs] = await Promise.all([
		import("./store.ts"),
		import("./store-config.ts"),
		import("./schema.ts"),
		import("node:fs/promises"),
	]);
	const subs = await listSubscriptions();
	const states = await Promise.all(subs.map((sub) => readState(sub.sess)));
	const touched = new Set<string>();
	for (const state of states) {
		for (const id of state.consumed ?? []) touched.add(id);
		for (const id of Object.keys(state.handled ?? {})) touched.add(id);
		for (const id of Object.keys(state.deferred ?? {})) touched.add(id);
	}
	const files = await listBriefFiles(7);
	const briefs = await readRecentBriefs(files, schema.DEFAULTS.listTailBytes, 300);
	const orphans = briefs.filter((brief) => !touched.has(brief.id));
	if (orphans.length === 0) return "无孤儿简报(每条都被至少一个会话处理过)";
	const lines = [`孤儿简报 ${orphans.length} 条(无会话 consumed/handled,可能是噪声或订阅不匹配):`];
	for (const brief of orphans.slice(0, limit)) {
		lines.push(`  ${new Date(brief.ts).toISOString().slice(5, 16)} [${brief.severity}] ${brief.title.slice(0, 46)}  (${brief.id})`);
	}
	if (orphans.length > limit) lines.push(`  … 另有 ${orphans.length - limit} 条`);
	const bySeverity: Record<string, number> = {};
	for (const brief of orphans) bySeverity[brief.severity] = (bySeverity[brief.severity] ?? 0) + 1;
	lines.push(`按严重度:${Object.entries(bySeverity).map(([k, v]) => `${k}=${v}`).join(" ")}`);
	return lines.join("\n");
}

/**
 * P4:硬清理历史简报 —— 命中的简报先落成一个 jsonl 再**移入系统回收站**(可还原),
 * 随后从归档文件与标签分片里剔除,并清掉各会话状态里的 unread。
 * apply=false 时只预览。
 */
