/**
 * 简报集散地核心(对外唯一入口)
 *
 * 投稿器/订阅器扩展与 CLI 都从这里导入,避免各自拼路径。
 */

export { DEFAULTS } from "./schema.ts";
export type { Brief, Kind, Severity, SubState, Subscription } from "./schema.ts";
export { deriveTags, scoreBrief, tagChain, tagsIntersect } from "./tags.ts";
export { buildBrief, clamp, dedupeKey, makeId } from "./brief.ts";
export { estimateTokens, inQuietHours, planDelivery, renderBrief, renderDigest } from "./match.ts";
export { alignCursor, defaultSub, pollOnce } from "./inbox.ts";
export { maxFanoutFor, readFanoutIndex, readRecentBriefs, rebuildFanoutIndex } from "./store-config.ts";
export { readShards, shardFile, shardsDir, writeShards } from "./shards.ts";
export {
	appendBrief,
	briefsDir,
	hubRoot,
	hubStats,
	listBriefFiles,
	listSubscriptions,
	markConsumed,
	readAfter,
	readConfig,
	readState,
	readSubscription,
	safeName,
	stateDir,
	subsDir,
	writeConfig,
	writeState,
	writeSubscription,
} from "./store.ts";
export { PROTOCOL_HINT, composeInjection, suggestedTagsFor } from "./inject.ts";
export { DEFER_RESURFACE_MS, classify, groupPending, handlingStats, renderProtocol, shouldSurface } from "./handling.ts";
export type { ActionClass, HandlingState, PendingItem } from "./handling.ts";
export { errorClass, errorText } from "./errors.ts";
export { filterFromArgs, matchesFilter, selectForPurge } from "./purge.ts";
export type { PurgeFilter } from "./purge.ts";
export { toRecycleBin } from "./recycle.ts";
export { stripBriefs } from "./purge.ts";
