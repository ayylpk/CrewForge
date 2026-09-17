// ============================================================
// tools/probeEnv.ts —— 环境自省工具（模型可随时主动重探本机）
//
//   与提示词里注入的环境简报（graph.ts 的 envBriefCache ← inspectProject 刷新）分工：
//     · 简报：开工时给一份**基线**，让选型/初始化方式从第一轮就基于实况；
//     · 本工具：跑着跑着想确认某件事时主动查（"这台机器到底有没有 pnpm / 端口占没占 /
//       能不能连 registry"）——比如 `npm create vite` 失败后，先确认真因再决定换路。
//
//   为什么把它做成工具而不是让模型猜：
//     "环境里有什么"是可观测事实，不该由模型凭印象猜。猜错的代价是整轮实现方向跑偏
//     （s4 的 Spring Boot 骨架就是这么铺到 Node 需求上的）。
//
//   只读、无副作用：探测只做"定位 + 取版本"。**例外已封死**——浏览器这类"执行即有
//   可见副作用"的工具只按安装位定位、绝不执行（见 envProbe.ts 的 noExec：
//   `msedge --version` 会真弹一个浏览器窗口出来）。
// ============================================================

import { num, str } from "./registry";
import type { ToolContext, ToolResult, ToolSpec } from "./registry";
import { probeEnvironment, renderEnvBrief } from "../envProbe";

export const probeEnvTool: ToolSpec = {
    name: "probeEnv",
    description: "实测本机环境（只读，无副作用）：npm/npx/pnpm/bun、java/mvn、python、docker、"
        + "git、mysql/sqlite3、无头浏览器是否可用及版本；npm registry 是否可达；常用端口是否空闲。"
        + "用途：不确定某条路能不能走（脚手架、某栈、某端口、联网）时先查一次，再决定怎么做。"
        + "返回一份可读简报；同一进程 60s 内重复调用命中缓存（除非 refresh=true）。",
    parameters: {
        ports: { type: "array", required: false, description: "要检查的端口（默认 3000/5173/8080/8000）" },
        refresh: { type: "boolean", required: false, description: "true = 跳过 60s 缓存强制重探" },
    },
    async run(_ctx: ToolContext, args): Promise<ToolResult> {
        const rawPorts = Array.isArray(args["ports"]) ? (args["ports"] as unknown[]) : [];
        const ports = rawPorts
            .map((p) => (typeof p === "number" ? p : Number(str({ v: p }, "v"))))
            .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
        const refresh = args["refresh"] === true || num({ v: args["refresh"] }, "v", 0) === 1;
        try {
            const probe = await probeEnvironment({
                ...(ports.length > 0 ? { ports } : {}),
                ...(refresh ? { refresh: true } : {}),
            });
            const brief = renderEnvBrief(probe);
            const missing = probe.tools.filter((t) => !t.available).map((t) => t.name);
            return {
                ok: true,
                output: brief,
                // meta 里给机器可读的原始数据，便于模型精确判断（不是只给一段文字）
                meta: {
                    probedAt: probe.probedAt,
                    available: probe.tools.filter((t) => t.available).map((t) => `${t.name}${t.version ? `@${t.version}` : ""}`),
                    missing,
                    npmRegistry: probe.network.npmRegistry,
                    ports: probe.ports,
                    notes: probe.notes,
                },
            };
        } catch (e) {
            return {
                ok: false,
                output: `环境探测失败：${String((e as Error).message ?? e)}（按最保守的可用工具继续，不要假设某工具存在）`,
                meta: { code: "PROBE_FAILED" },
            };
        }
    },
};
