import { readAfter } from "./store.ts";
import { join } from "node:path";
import type { Brief } from "./schema.ts";

export async function purgeBriefs(filter: import("./purge.ts").PurgeFilter, apply: boolean): Promise<string> {
	const [{ listBriefFiles, hubRoot }, { readRecentBriefs }, schema, purge, recycle, fs] = await Promise.all([
		import("./store.ts"),
		import("./store-config.ts"),
		import("./schema.ts"),
		import("./purge.ts"),
		import("./recycle.ts"),
		import("node:fs/promises"),
	]);
	const files = await listBriefFiles(14);
	const briefs = await readRecentBriefs(files, schema.DEFAULTS.listTailBytes * 4, 500);
	const ids = purge.selectForPurge(briefs, filter);
	const lines = [`命中 ${ids.length} 条${apply ? "" : "(预览,未改动)"}`];
	const hit = briefs.filter((b) => ids.includes(b.id));
	for (const brief of hit.slice(0, 8)) {
		lines.push(`  ${new Date(brief.ts).toISOString().slice(5, 16)} [${brief.severity}] ${brief.title.slice(0, 46)}  (${brief.id})`);
	}
	if (ids.length > 8) lines.push(`  … 另有 ${ids.length - 8} 条`);
	if (!apply || ids.length === 0) {
		if (!apply && ids.length > 0) lines.push("确认后加 --yes 执行(命中内容移入系统回收站,归档与分片同步剔除)");
		return lines.join("\n");
	}

	const trashDir = join(hubRoot(), "trash");
	await fs.mkdir(trashDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const trashFile = join(trashDir, `purged-${stamp}.jsonl`);
	await fs.writeFile(trashFile, hit.map((b) => JSON.stringify(b)).join("\n") + "\n", "utf8");
	const recycled = await recycle.toRecycleBin(trashFile);

	let touched = 0;
	const rewrite = async (path: string): Promise<void> => {
		try {
			const text = await fs.readFile(path, "utf8");
			const result = purge.stripBriefs(text, ids);
			if (result.removed > 0) {
				await fs.writeFile(path, result.kept, "utf8");
				touched++;
			}
		} catch {
			/* 忽略不存在/读失败 */
		}
	};
	for (const file of files) await rewrite(file);
	try {
		for (const name of await fs.readdir(join(hubRoot(), "shards"))) await rewrite(join(hubRoot(), "shards", name));
	} catch {
		/* 无分片目录 */
	}
	lines.push(`已从 ${touched} 个文件剔除;命中内容${recycled ? "已移入系统回收站" : "已删除(回收站不可用)"}`);
	return lines.join("\n");
}
