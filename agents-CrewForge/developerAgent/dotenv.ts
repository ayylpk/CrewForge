// ============================================================
// developerAgent/dotenv.ts —— 仓库 .env 强制加载（覆盖 shell 继承值）
//
// 为什么需要它（9/14 实测踩坑）：
//   本机 shell 里继承着 Claude Code 自己的 ANTHROPIC_BASE_URL（指向另一个
//   中转站 api.daseinai.xyz）。Bun **不会覆盖已存在的 process.env**，
//   所以走 createRealLlm 的 process.env 兜底会拿到错误端点 —— 实测表现为
//   HTTP 404 `Model "qwen3.8-flash" is not supported by any configured account`。
//
// 本模块的语义：**以仓库 .env 为准**，与 shell 里恰好有什么无关。
//   显式 opts 传参（createRealLlm({ baseUrl })）仍然优先级最高，不受影响。
//
// 用法（进入点第一件事）：
//   import { loadDotEnv } from "../dotenv";
//   loadDotEnv();
// ============================================================

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** agents-CrewForge/.env 的绝对路径（本文件在 developerAgent/ 下，退一级） */
export function envFilePath(): string {
    return join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
}

/**
 * 读 .env 并**写入** process.env（覆盖已有值）。
 * 文件不存在或读失败时不抛错——回退到 shell 环境变量，由调用方自然失败并报错。
 * @returns 实际加载的键数；-1 表示没读到文件
 */
export function loadDotEnv(envPath: string = envFilePath()): number {
    if (!existsSync(envPath)) return -1;
    let loaded = 0;
    try {
        for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(trimmed);
            if (m?.[1] === undefined) continue;
            process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
            loaded++;
        }
    } catch {
        return -1;
    }
    return loaded;
}
