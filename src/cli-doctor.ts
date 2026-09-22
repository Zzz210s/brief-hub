import { readAfter } from "./store.ts";
import { join } from "node:path";
import type { Brief } from "./schema.ts";

export async function doctorRows(): Promise<DoctorRow[]> {
	const { homedir } = await import("node:os");
	const { existsSync } = await import("node:fs");
	const { hubRoot } = await import("./store.ts");
	const rows: DoctorRow[] = [];
	rows.push({ name: "node", ok: Number(process.versions.node.split(".")[0]) >= 24, detail: `v${process.versions.node}` });
	rows.push({ name: "数据目录", ok: existsSync(hubRoot()), detail: hubRoot() });
	rows.push({ name: "简报目录", ok: existsSync(join(hubRoot(), "briefs")), detail: join(hubRoot(), "briefs") });
	rows.push({ name: "订阅目录", ok: existsSync(join(hubRoot(), "subs")), detail: join(hubRoot(), "subs") });

	const harnesses: [string, string][] = [
		["pi", join(homedir(), ".pi", "agent")],
		["Claude Code", join(homedir(), ".claude")],
		["Codex", join(homedir(), ".codex", "config.toml")],
		["opencode", join(homedir(), ".config", "opencode")],
	];
	for (const [name, path] of harnesses) {
		const present = existsSync(path);
		rows.push({ name: `harness ${name}`, ok: present, detail: present ? path : "未安装(不影响 CLI)" });
	}
	const piExt = existsSync(join(homedir(), ".pi", "agent", "extensions", "brief-subscriber.ts"));
	rows.push({ name: "pi 扩展", ok: piExt, detail: piExt ? "已安装投稿器/订阅器" : "未安装(可选)" });
	const claudeHook = await (async () => {
		try {
			const raw = await import("node:fs/promises").then((fs) => fs.readFile(join(homedir(), ".claude", "settings.json"), "utf8"));
			return raw.includes("adapters") && raw.includes("hook.mjs");
		} catch {
			return false;
		}
	})();
	rows.push({ name: "Claude hook", ok: claudeHook, detail: claudeHook ? "已合并" : "未安装(可选)" });
	return rows;
}

/** 把 doctor 结果渲染成文本 */

export function formatDoctor(rows: DoctorRow[]): string {
	const lines = rows.map((row) => `${row.ok ? "OK  " : "--  "} ${row.name.padEnd(18)} ${row.detail}`);
	lines.push("");
	lines.push("提示:CLI 与集散地本身不依赖任何 AI;上表未安装的 harness 只是可选接线缺席。");
	return lines.join("\n");
}

/** 标记"已处理"(handled)或"已延迟"(deferred);返回是否成功 */
