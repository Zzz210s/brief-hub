/**
 * 数据模型与默认值(纯声明,无副作用)
 *
 * 设计要点:简报是"集散地"的唯一货币,字段有界 —— 标题一行、事实至多三条,
 * 正文细节靠 artifacts 按需展开。这样消费者只付"标题"的钱,需要时才读正文。
 */

export type Kind = "task.done" | "task.error" | "git.push" | "git.commit" | "config.changed" | "note";
export type Severity = "err" | "warn" | "info";

/** 一条简报(集散地的存储单元) */
export interface Brief {
	/** 唯一 id,形如 b-20260921-1a2b */
	id: string;
	/** 毫秒时间戳 */
	ts: number;
	kind: Kind;
	severity: Severity;
	/** 来源会话 */
	src: { sess: string; tool: string; name: string; cwd: string };
	/** 标签:匹配的唯一依据(层级,如 git / git.push / repo:owner/name) */
	tags: string[];
	/** 标题,一行(建议 <= 60 字符) */
	title: string;
	/** 要点,至多 3 条 */
	facts: string[];
	/** 建议动作(一条命令),可空 */
	action?: string;
	/** 按需展开的细节 */
	artifacts: { type: string; ref: string }[];
	/** 存活秒数;过期后不再投递 */
	ttl: number;
	/** 去重键:同键在合并窗口内合并为一条 */
	key: string;
	/** 会话内序号,便于追溯 */
	seq?: number;
}

/** 每条简报/每个会话的订阅配置 */
export interface Subscription {
	/** 会话标识(pi 会话 id 或自定义名) */
	sess: string;
	/** 关心的标签(支持父级:订阅 git 会命中 git.push) */
	tags: string[];
	/** 命中门槛(默认 1.0:父级命中恰好达标,精确命中 2.0 必达) */
	minScore?: number;
	/** 每小时 token 预算(默认 2000) */
	budgetPerHour?: number;
	/** 投递级别:l1=标题批摘要(默认);l2=命中即注入正文 */
	delivery?: "l1" | "l2" | "off";
	/** 静默时段(本地小时,[起,止),跨零点支持) */
	quietHours?: [number, number];
	/** 亲和的仓库(同仓库命中加权) */
	repos?: string[];
	/** 亲和的目录前缀(同目录命中加权) */
	cwds?: string[];
}

/** 消费者游标状态 */
export interface SubState {
	/** 已读到的字节偏移(旧字段:单文件游标,保留兼容) */
	cursor?: number;
	/** 每文件游标:{绝对路径: 字节偏移} —— 跨天轮转时不会重放 */
	cursors?: Record<string, number>;
	/** 已投递但未读的 id(供 --unread 列出) */
	unread: string[];
	/** 已消费的 id(窗口内);超出窗口自动裁剪 */
	consumed: string[];
	/** 已消费时间戳,用于裁剪 */
	consumedAt?: Record<string, number>;
	/** 当前小时的预算使用量 */
	budget?: { hourStart: number; used: number };
	/** 上次投递时间 */
	lastDeliveryAt?: number;
}

export const DEFAULTS = {
	/** 消费者轮询间隔(毫秒) */
	pollMs: 7000,
	/** 同去重键的合并窗口(毫秒) */
	coalesceMs: 600_000,
	/** 命中门槛 */
	minScore: 1.0,
	/** 每小时 token 预算 */
	budgetPerHour: 2000,
	/** 已读记录保留窗口(毫秒),超出即裁剪 */
	consumedWindowMs: 7 * 24 * 3600_000,
	/** 简报默认存活 */
	ttlSeconds: 86_400,
	/** 估价:每个字符约 0.25 token(中英混排的保守估计) */
	tokensPerChar: 0.25,
	/** 每条标题的固定开销(消息框架/标记) */
	perBriefOverheadTokens: 8,
} as const;
