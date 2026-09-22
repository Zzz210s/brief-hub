/**
 * /hub 子命令的实现(从 brief-subscriber.ts 抽出,保持单文件 ≤200 行)。
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";

type Ctx = { load: () => Promise<any>; meta: { sessionId: string; name?: string; cwd: string }; STATUS_KEY: string };

export function registerHubCommand(pi: any, ctx: Ctx): void {
	const { load, meta } = ctx;

	pi.registerCommand("hub", {
		description: "简报集散地:status/list/read/sub/off",
		handler: async (args: string, ctx: any) => {
			const mod = await load();
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const action = parts[0] ?? "status";
			const reply = (text: string): void => ctx?.ui?.notify?.(text, "info");

			if (action === "status") {
				const state = await mod.readState(meta.sessionId);
				const sub = await mod.readSubscription(meta.sessionId);
				reply(`简报:未读 ${state.unread?.length ?? 0} · 已读 ${state.consumed?.length ?? 0} · 订阅 [${(sub?.tags ?? []).join(", ")}] · 级别 ${sub?.delivery ?? "l1"}`);
				return;
			}
			if (action === "list") {
				const files = await mod.listBriefFiles(3);
				const briefs: any[] = [];
				for (const file of files) briefs.push(...(await mod.readAfter(file, 0)).briefs);
				const state = await mod.readState(meta.sessionId);
				const unreadIds = new Set(state.unread ?? []);
				const rows = briefs
					.filter((brief) => unreadIds.has(brief.id))
					.sort((a, b) => b.ts - a.ts)
					.slice(0, 10)
					.map((brief) => `${brief.id} [${brief.kind}] ${brief.title}`);
				reply(rows.length ? rows.join("\n") : "无未读简报");
				return;
			}
			if (action === "read") {
				const id = parts[1];
				if (!id) return reply("用法: /hub read <id>");
				const files = await mod.listBriefFiles(3);
				let found: any;
				for (const file of files) {
					const briefs = (await mod.readAfter(file, 0)).briefs;
					found = briefs.find((brief) => brief.id === id) ?? found;
				}
				if (!found) return reply(`未找到 ${id}`);
				const state = await mod.readState(meta.sessionId);
				await mod.writeState(meta.sessionId, mod.markConsumed(state, [id]));
				reply(mod.renderBrief(found));
				return;
			}
			if (action === "sub") {
				const sub = (await mod.readSubscription(meta.sessionId)) ?? mod.defaultSub(meta.sessionId, []);
				const verb = parts[1];
				if (verb === "add") {
					const tags = new Set([...sub.tags, ...parts.slice(2)]);
					await mod.writeSubscription({ ...sub, tags: [...tags].sort() });
					return reply(`订阅已更新: [${[...tags].join(", ")}]`);
				}
				if (verb === "rm") {
					const drop = new Set(parts.slice(2));
					const tags = sub.tags.filter((tag: string) => !drop.has(tag));
					await mod.writeSubscription({ ...sub, tags });
					return reply(`订阅已更新: [${tags.join(", ")}]`);
				}
				return reply(`当前订阅: [${sub.tags.join(", ")}]`);
			}
			if (action === "l2" || action === "l1" || action === "off") {
				const sub = (await mod.readSubscription(meta.sessionId)) ?? mod.defaultSub(meta.sessionId, []);
				await mod.writeSubscription({ ...sub, delivery: action });
				return reply(`投递级别: ${action}`);
			}
			reply("用法: /hub [status|list|read <id>|sub add|rm <标签>|l1|l2|off]");
		},
	});
}

/**
 * pi 会把 extensions/ 下的每个顶层 .ts 当扩展加载:本文件是 brief-subscriber 的辅助模块,
 * 故导出一个空工厂函数以满足加载器(真正的注册由 brief-subscriber.ts 调用 registerHubCommand)。
 */
export default function (): void {};
