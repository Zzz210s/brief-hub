/**
 * 订阅器(pi 扩展):轮询简报集散地,只把"与我相关"的简报标题送进上下文,立刻标记已读。
 *
 * 省 token 的落点:
 *   - 匹配是纯代码(标签集合 + 打分),不调模型
 *   - 无新增文件(游标未前进)时一次读都不做,也不产生任何注入
 *   - 投递的是"标题批摘要"(一级);要看正文用 /hub read <id>
 *   - 投递后立即写已读,下一轮不再检测同一条
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerHubCommand } from "./brief-hub-cmd.ts";

const REPO = process.env.BRIEF_HUB_HOME || join(homedir(), "brief-hub");
const STATUS_KEY = "brief-hub";

interface Meta {
	sessionId: string;
	name: string;
	cwd: string;
}

export default function (pi: any): void {
	if (process.env.BRIEF_HUB === "0") return;

	let meta: Meta = { sessionId: "", name: "", cwd: process.cwd() };
	let core: any;
	let timer: ReturnType<typeof setInterval> | null = null;
	let busy = false;
	let unread = 0;

	const load = async (): Promise<any> => (core ??= await import(pathToFileURL(join(REPO, "src", "index.ts")).href));

	const ensureSubscription = async (): Promise<void> => {
		const mod = await load();
		const existing = await mod.readSubscription(meta.sessionId);
		if (existing) return;
		// 自动推导兴趣标签(手动 /hub sub add 可覆盖)
		const derived = mod.deriveTags({
			tool: "pi",
			sessionName: meta.name,
			cwd: meta.cwd,
			changedPaths: [],
			commands: [],
		});
		const auto = derived.filter((tag: string) => !tag.startsWith("tool:") && !tag.startsWith("sess:") && !tag.startsWith("sev:"));
		const sub = mod.defaultSub(meta.sessionId, [...new Set([...auto, "sev:err"])]);
		await mod.writeSubscription(sub);
	};

	const tick = async (): Promise<void> => {
		if (busy) return;
		busy = true;
		try {
			const mod = await load();
			// peek:只算"待读有多少"给徽标用 —— 不消费,避免简报被看板吃掉
			const peeked = await mod.pollOnce(meta.sessionId, { peek: true });
			const result = peeked;
			unread = peeked.plan ? peeked.plan.matchedIds.length : (peeked.state?.unread?.length ?? 0);
			const badge = unread > 0 ? `简报 ${unread}` : undefined;
			try {
				pi.ui?.setStatus?.(STATUS_KEY, badge);
			} catch {
				/* 无 UI 忽略 */
			}
			if (result.digest) {
				try {
					pi.ui?.notify?.(result.digest, "info");
				} catch {
					/* 无 UI 忽略 */
				}
			}
		} catch {
			/* 轮询失败绝不影响会话 */
		} finally {
			busy = false;
		}
	};

	pi.on("session_start", async (_event: unknown, ctx: any) => {
		try {
			meta = {
				sessionId: ctx?.sessionManager?.getSessionId?.() ?? "",
				name: ctx?.sessionManager?.getSessionName?.() ?? "",
				cwd: ctx?.sessionManager?.getCwd?.() ?? process.cwd(),
			};
			if (!meta.sessionId) return;
			await ensureSubscription();
			const mod = await load();
			const config = await mod.readConfig();
			// 首次运行只对齐游标,不投递历史(避免一次灌进几百条)
			await mod.alignCursor(meta.sessionId);
			if (timer) clearInterval(timer);
			timer = setInterval(() => void tick(), Number(config.pollMs ?? 7000));
			timer.unref?.();
		} catch {
			/* 初始化失败忽略 */
		}
	});

	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		timer = null;
	});


	// 关键:把简报送进**模型上下文**(而非只弹界面通知)。
	// pi 的 before_agent_start 支持返回一条自定义消息,这是扩展能影响本轮的官方通道。
	pi.on("before_agent_start", async () => {
		try {
			const mod = await load();
			const result = await mod.pollOnce(meta.sessionId);
			unread = result.state?.unread?.length ?? 0;
			const injected = mod.composeInjection(result.digest ?? "");
			if (!injected) return; // 无相关简报 -> 完全不注入(0 token)
			try {
				pi.ui?.setStatus?.(STATUS_KEY, unread > 0 ? `简报 ${unread}` : undefined);
			} catch {
				/* 无 UI 忽略 */
			}
			return {
				message: {
					customType: "brief-hub",
					content: injected,
					display: true,
				},
			};
		} catch {
			return;
		}
	});

	registerHubCommand(pi, { load, meta, STATUS_KEY });
}
