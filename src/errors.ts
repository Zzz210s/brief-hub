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
