/**
 * 让会话"意识到"简报的注入文案(纯函数,所有 harness 共用一处措辞)。
 *
 * 背景:简报投递若只走"界面通知"(ui.notify),模型是看不到的 —— 它只到人的眼睛。
 * 各 harness 都有一条能把文本送进**模型上下文**的通道(pi 的 before_agent_start
 * 返回 message;Claude 的 UserPromptSubmit stdout;opencode 的 chat.message parts),
 * 本模块负责统一措辞与拼装,确保每个会话都知道:有简报、怎么读全文、怎么订阅。
 *
 * 成本:只在**确实有相关简报**时才产生文本(无简报返回 undefined,0 token)。
 */

/** 协议提示:每个 harness 的注入文案前缀(保持极短,约 40 token 以内) */
export const PROTOCOL_HINT =
	"简报集散地 brief-hub:以下简报与本会话订阅相关。读全文 bh read <id>;订阅 bh sub add <标签> --sess=<本会话>;任务结束时投稿是自动的。";

/** 组合注入文本;没有简报时返回 undefined(调用方应完全不注入) */
export function composeInjection(digest: string): string | undefined {
	const text = String(digest ?? "").trim();
	if (!text) return undefined;
	return `${PROTOCOL_HINT}\n${text}`;
}

/**
 * 会话订立"关注点"的建议:把常见角色映射到标签,便于在 AGENTS.md/CLAUDE.md 里
 * 告诉会话"你是专管什么的,该订阅什么"。
 */
export function suggestedTagsFor(name: string): string[] {
	const value = (name ?? "").toLowerCase();
	const tags = new Set<string>();
	if (/github|git\b|仓库/.test(value)) tags.add("git");
	if (/电脑|系统|优化|性能|清理|磁盘/.test(value)) tags.add("system");
	if (/配置|config|dotfiles/.test(value)) tags.add("config");
	if (/代码|code|refactor|重构/.test(value)) tags.add("code");
	tags.add("sev:err"); // 错误一律关心
	return [...tags].sort();
}
