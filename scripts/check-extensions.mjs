#!/usr/bin/env node
/**
 * 部署后自检:逐个 import 已部署的扩展文件,确认相对导入都能解析。
 *
 * 起因:拆分扩展文件后部署清单没跟上 -> 缺少模块 -> pi 启动报
 * "Failed to load extension",整个会话起不来。此脚本把这类问题挡在部署阶段。
 *
 * 用法:node scripts/check-extensions.mjs [扩展目录,默认 ~/.pi/agent/extensions]
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = process.argv[2] ?? join(homedir(), ".pi", "agent", "extensions");
if (!existsSync(dir)) {
	console.log(`没有扩展目录 ${dir},跳过`);
	process.exit(0);
}

const entries = (await readdir(dir)).filter((f) => f.startsWith("brief-") && f.endsWith(".ts"));
let failed = 0;
for (const file of entries) {
	try {
		await import(pathToFileURL(join(dir, file)).href);
		console.log(`  OK   ${file}`);
	} catch (error) {
		failed++;
		console.log(`  FAIL ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
console.log(failed === 0 ? `扩展自检通过(${entries.length} 个)` : `扩展自检失败 ${failed} 个 —— 部署不完整,pi 会加载失败`);
process.exit(failed === 0 ? 0 : 1);
