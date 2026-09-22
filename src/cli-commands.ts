import { one, parseArgs, readAllBriefs } from "./cli-support.ts";
import { listBriefFiles, listSubscriptions, readSubscription, writeSubscription } from "./store.ts";

/** 从 cli.ts 抽出的命令实现(保持单文件 ≤200 行) */


export async function cmdTag(args: ReturnType<typeof parseArgs>, sess?: string): Promise<void> {
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

export async function cmdList(args: ReturnType<typeof parseArgs>, sess?: string): Promise<void> {
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

export async function cmdRead(args: ReturnType<typeof parseArgs>, sess?: string): Promise<void> {
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
