// ============================================================
// tools.ts —— 工具定位（零 LLM）
//
//   为什么需要：本机 PATH 上的 `bun` 是 bvm 的 .cmd shim，`spawn("bun.exe")` 找不到可执行文件，
//   runContractTests 会直接以 tool_error 收场（契约测试根本没跑，验证据就断在这）。
//   这里按"真实 exe → PATH → 常见安装位置"的顺序定位，并把结果如实写进证据。
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ResolvedTool { cmd: string; source: string }

const IS_WIN = process.platform === "win32";

/** 找真实 bun 可执行文件（Windows 上 shim 是 .cmd，不能直接 spawn） */
export function resolveBunExe(): ResolvedTool {
    const candidates: string[] = [];
    const bvmRuntime = path.join(os.homedir(), ".bvm", "runtime");
    try {
        for (const v of fs.readdirSync(bvmRuntime)) {
            candidates.push(path.join(bvmRuntime, v, "bin", IS_WIN ? "bun.exe" : "bun"));
        }
    } catch { /* 没装 bvm */ }
    candidates.push(path.join(os.homedir(), ".bun", "bin", IS_WIN ? "bun.exe" : "bun"));
    for (const c of candidates) {
        try { if (fs.existsSync(c)) return { cmd: c, source: `真实可执行文件：${c}` }; } catch { /* 继续 */ }
    }
    const pathHit = process.env.PATH?.split(path.delimiter)
        .map(d => path.join(d, IS_WIN ? "bun.exe" : "bun"))
        .find(p => { try { return fs.existsSync(p); } catch { return false; } });
    if (pathHit) return { cmd: pathHit, source: `PATH 命中：${pathHit}` };
    return { cmd: IS_WIN ? "bun.exe" : "bun", source: "未定位到真实 exe，回退 PATH 名称（可能 spawn 失败）" };
}
