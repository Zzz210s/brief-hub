import { readAfter } from "./store.ts";
import { join } from "node:path";
import type { Brief } from "./schema.ts";

export async function markHandling(sess: string, ids: string[], mode: "handle" | "defer", now = Date.now()): Promise<{ ok: number; state: unknown }> {
	const { readState, writeState } = await import("./store.ts");
	const state = await readState(sess);
	const handled = { ...(state.handled ?? {}) };
	const deferred = { ...(state.deferred ?? {}) };
	let ok = 0;
	for (const id of ids) {
		if (mode === "handle") {
			handled[id] = now;
			delete deferred[id];
		} else {
			deferred[id] = now;
		}
		ok++;
	}
	const next = { ...state, handled, deferred, unread: (state.unread ?? []).filter((id) => !ids.includes(id)) };
	await writeState(sess, next);
	return { ok, state: next };
}

/** 列出需要处理的简报(按动作类分组) */

export async function pendingFor(sess: string, now = Date.now()): Promise<string> {
	const [{ listBriefFiles, readSubscription }, { readRecentBriefs }, handling, schema] = await Promise.all([
		import("./store.ts"),
		import("./store-config.ts"),
		import("./handling.ts"),
		import("./schema.ts"),
	]);
	const sub = await readSubscription(sess);
	if (!sub) return `无订阅:先 bh sub add <标签> --sess=${sess}`;
	const files = await listBriefFiles(3);
	const briefs = await readRecentBriefs(files, schema.DEFAULTS.listTailBytes, 200);
	const { readState } = await import("./store.ts");
	const state = await readState(sess);
	const items = briefs
		.filter((brief) => (sub.tags ?? []).some((tag) => (brief.tags ?? []).includes(tag)) || brief.severity === "err")
		.filter((brief) => handling.shouldSurface(brief, state, now))
		.map((brief) => ({ brief, action: handling.classify(brief, sub), resurfaced: Boolean(state.deferred?.[brief.id]) }));
	const text = handling.renderProtocol(items, { maxPerClass: 8 });
	const stats = handling.handlingStats(state, now);
	return `${text ?? "无待处理简报"}

(已处理 ${stats.handled} · 延迟中 ${stats.deferred} · 延迟到期 ${stats.deferredDue})`;
}

/** 当前待处理的简报 id(供 bh handle/defer 省略 id 时使用) */

export async function pendingIds(sess: string, now = Date.now()): Promise<string[]> {
	const [{ listBriefFiles, readState, readSubscription }, { readRecentBriefs }, handling, schema] = await Promise.all([
		import("./store.ts"),
		import("./store-config.ts"),
		import("./handling.ts"),
		import("./schema.ts"),
	]);
	const sub = await readSubscription(sess);
	if (!sub) return [];
	const files = await listBriefFiles(3);
	const briefs = await readRecentBriefs(files, schema.DEFAULTS.listTailBytes, 200);
	const state = await readState(sess);
	return briefs
		.filter((brief) => (sub.tags ?? []).some((tag) => (brief.tags ?? []).includes(tag)) || brief.severity === "err")
		.filter((brief) => handling.shouldSurface(brief, state, now))
		.map((brief) => brief.id);
}

/** P3:列出"没有任何会话处理过"的简报(孤儿)-> 一眼看出谁在持续产噪声 */
