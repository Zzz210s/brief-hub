import assert from "node:assert/strict";
import { test } from "node:test";
import { errorText } from "../src/errors.ts";

test("errorText:字符串原样返回", () => {
	assert.equal(errorText("bash: command not found"), "bash: command not found");
});

test("errorText:Error 取 message", () => {
	assert.equal(errorText(new Error("socket hang up")), "socket hang up");
});

test("errorText:{message} 对象", () => {
	assert.equal(errorText({ message: "请求超时" }), "请求超时");
});

test("errorText:pi 工具结果 {isError,content:[{type,text}]}(旧实现会退化成 [object Object])", () => {
	const event = {
		isError: true,
		result: { isError: true, content: [{ type: "text", text: "Cannot read properties of undefined" }] },
	};
	assert.equal(errorText(event.result), "Cannot read properties of undefined");
});

test("errorText:多段内容用 | 连接", () => {
	const result = { content: [{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }] };
	assert.equal(errorText(result), "第一段 | 第二段");
});

test("errorText:嵌套包装逐层下钻", () => {
	const payload = { error: { content: [{ text: "深层错误" }] } };
	assert.equal(errorText(payload), "深层错误");
});

test("errorText:无用值一律返回 undefined", () => {
	for (const value of [undefined, null, "", "[object Object]", "{}", [], {}]) {
		assert.equal(errorText(value), undefined, `应当忽略: ${JSON.stringify(value)}`);
	}
});

test("errorText:换行折叠成一行并截断到上限", () => {
	const text = errorText(`第一行\n第二行\r\n${"x".repeat(300)}`, 40);
	assert.ok(text);
	assert.equal(text.includes("\n"), false);
	assert.equal(text.length, 40);
});

test("errorText:循环引用不抛错(退化为空)", () => {
	const cyclic = {};
	cyclic.self = cyclic;
	assert.equal(errorText(cyclic), undefined);
});
