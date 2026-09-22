/**
 * 错误文本提取(纯函数):把各种形态的"失败信息"归一成一行可读文本。
 *
 * 为什么需要它:各 harness 传进来的失败载荷形状不一 —— 有的是字符串,有的是 Error,
 * 有的是 { isError, content: [{ type: "text", text }] } 这种工具结果包装。
 * 早期实现直接 `String(result.content)`,于是简报要点只剩 `[object Object]`,
 * 对读简报的会话毫无价值(2026-09-21 实测踩到)。
 */

const USELESS = new Set(["", "[object Object]", "undefined", "null", "{}", "[]"]);
const MAX_DEPTH = 4;

function pick(value: unknown, depth: number): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	if (value instanceof Error) return value.message;
	if (typeof value === "number" || typeof value === "boolean") return String(value);

	if (Array.isArray(value)) {
		return value
			.map((item) => pick(item, depth + 1))
			.filter(Boolean)
			.join(" | ");
	}

	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (depth < MAX_DEPTH) {
			// 常见包装键:优先取最像"人话"的那个
			for (const key of ["error", "message", "text", "stderr", "output", "content", "result", "data"]) {
				if (key in record) {
					const text = pick(record[key], depth + 1);
					if (text) return text;
				}
			}
		}
		try {
			return JSON.stringify(record) ?? "";
		} catch {
			return "";
		}
	}

	return "";
}

/** 提取一行错误文本;取不到有效内容时返回 undefined(而不是 "[object Object]") */
export function errorText(value: unknown, limit = 200): string | undefined {
	const raw = pick(value, 0).replace(/\s+/g, " ").trim();
	if (USELESS.has(raw)) return undefined;
	return raw.length > limit ? raw.slice(0, limit) : raw;
}

/**
 * 错误分类(纯函数):决定这条失败值不值得广播给所有订阅者。
 *
 * 背景(2026-09-22 实测):投稿器把"会话中途某条命令语法错"也当任务失败投成 sev:err,
 * 于是 `unexpected EOF`、`ENOENT: …`、我们自己的调试命令回显都变成"必须处理",
 * 打扰了 45 个会话。这类瞬时失败下一条命令就修好,不该占用别人的注意力。
 *
 *   task      任务级失败(构建/测试/CI/agent 自身报错)-> 值得投 sev:err
 *   transient 工具级瞬时失败(语法错/命令不存在/调试回显)-> 不投(或降级 warn)
 */
const NOISE_PATTERNS: RegExp[] = [
	/\[object Object\]/,
	/SyntaxWarning|DeprecationWarning|RuntimeWarning/, // python 警告:自己的脚本回显
	/^<stdin>:\d+:/, // heredoc 里的报错
	/unexpected EOF/i,
	/syntax error near/i,
	/command not found/i,
	/is not recognized as/i,
	/--check|sync-rules|sync-mcp/, // 我们自己的维护命令
	/^\/usr\/bin\/bash: -c:/,
	/TerminatorExpectedAtEndOfString/i,
	/\[rtk\]|No hook installed/, // 第三方 CLI 的横幅(rtk)
	/Could not find edits\[\d+\]/, // 编辑工具重试:同一改动下一条命令就成
	/Dangerous command blocked/, // 权限门按设计拦截,不是失败
];

/** 代码/搜索输出被当成错误文本(多行 `123: xxx`) */
function looksLikeCodeOutput(text: string): boolean {
	return (text.match(/(^|\s)\d{1,4}:\s/g) ?? []).length >= 2;
}

/**
 * 错误三分类(纯函数):
 *   noise 纯噪声(工具回显/警告/过短)-> 丢弃,不投
 *   tool  工具级可行动失败(缺文件/权限/超时)-> 投 sev:warn,不占"必须处理"配额
 *   task  任务级失败(构建/测试/CI/依赖)-> 投 sev:err
 */
export function errorClass(text: string | undefined): "noise" | "tool" | "task" {
	const value = (text ?? "").trim();
	if (value.length < 8) return "noise";
	for (const pattern of NOISE_PATTERNS) if (pattern.test(value)) return "noise";
	if (looksLikeCodeOutput(value)) return "noise";
	if (/ENOENT|EACCES|EPERM|ETIMEDOUT|timed out|permission denied/i.test(value)) return "tool";
	if (/npm ERR!|FAIL|assert|panic|Traceback \(most recent call last\)|exit code [1-9]/i.test(value)) return "task";
	return "task";
}
