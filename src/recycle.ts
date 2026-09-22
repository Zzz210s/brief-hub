/**
 * 回收站(Windows):把文件移入系统回收站而不是直接删除。
 *
 * 为什么不用 fs.unlink:清理是破坏性操作,放进回收站可在资源管理器里还原
 * (与 ai-session-hub 的会话删除同一策略)。非 Windows 平台退回 unlink。
 */

import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { spawn } from "node:child_process";

/** 把文件移入系统回收站;失败时退回直接删除。返回是否成功 */
export async function toRecycleBin(path: string): Promise<boolean> {
	if (!existsSync(path)) return false;
	if (process.platform !== "win32") {
		await unlink(path).catch(() => undefined);
		return true;
	}
	const script = [
		"Add-Type -AssemblyName Microsoft.VisualBasic",
		`[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${path.replace(/'/g, "''")}', 'OnlyErrorDialogs', 'SendToRecycleBin')`,
	].join("; ");
	return new Promise((resolve) => {
		const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
		child.on("error", async () => {
			await unlink(path).catch(() => undefined);
			resolve(false);
		});
		child.on("exit", (code) => resolve(code === 0));
	});
}
