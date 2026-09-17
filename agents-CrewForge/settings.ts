import { pool } from "./db";
import type { RowDataPacket } from "mysql2/promise";

/**
 * settings.ts —— sys_settings 单行运行时配置读取（cc-switch 配置层的引擎半边）
 *
 * 优先级（v2 拍板）：sys_settings > .env > 内置默认。
 * 旁路原则同任务桥：读不到/表为空只 warn，引擎按 .env/内置继续跑——配置层是可观测/可调节层，不是控制层。
 * 缓存：30s TTL + 强制刷新口；runner 起心跳定时器，设置页改动半分钟内生效（不做热推送）。
 */

export interface RtSettings {
    /** 全局模型名（设置页一旦填写即覆盖所有角色内置名；T3 在其上再分档） */
    modelName: string | null;
    /** T3 pro 档模型名（空=分层不启用，pro 角色退回全局名） */
    modelPro: string | null;
    /** T3 角色→档位 JSON 文本 {architect:"pro",...}（VARCHAR 存文本防 F6 JSON 列三番坑；坏值回落内置表） */
    roleModels: string | null;
    /** openai 兼容端点 baseURL（modelKind=openai 必填） */
    modelUrl: string | null;
    /** 端点密钥（空=沿用 .env 的 DEEPSEEK_API_KEY） */
    apiKey: string | null;
    /** "deepseek" | "openai"（表列 model_kind，与 models.ts MAPS 键一致） */
    modelKind: string;
    /** 引擎回调 Java 基址（A7 根治：Node.ts 不再写死 localhost:8080） */
    javaBaseUrl: string;
    /** 确认门无应答自动放行分钟数（阶段 3 消费） */
    confirmTimeoutMin: number;
    /** 冒烟是否追加 build（阶段 4 消费） */
    smokeBuild: boolean;
    /** T7a 最外层端点总闸：全局同时最多几个 LLM 调用在飞（默认 6；F1 实测 8 并发炸尾延迟） */
    llmConcurrency: number;
    /** T7a 阶段在制令牌：每把工位阶段闸的 token 数（默认 5；前后端各阶段共用这一个旋钮） */
    stationSlots: number;
    /** T7b 工位工具模式：true=前后端开发用 read/write/edit 工具循环交付（端点兼容性 live 验证后再开） */
    toolMode: boolean;
    /**
     * ★ 上下文窗口（token）：该模型**真实**的最大输入 token，用户填的全局基准。
     *   消费方：`contextBudget.resolveContextWindow` 的第 ② 优先级（阈值全是它的比例）。
     *   null = 没配（**列还没建**也算没配）→ 引擎按 `[1m]` 模型名 / env / 产品默认 256_000
     *   继续跑，并喊一行告警 + 台账留 degraded 痕迹。旁路原则同本文件其余字段。
     */
    contextWindow: number | null;
    /** ★ T3 pro 档的上下文窗口覆盖（pro 档模型名可能是 `deepseek-v4-pro[1m]`，与 flash 档差一个数量级） */
    contextWindowPro: number | null;
}

/**
 * `sys_settings` 的两个窗口列 → `RtSettings.contextWindow / contextWindowPro`。
 *
 *   抽成**独立纯函数**（而不是写在 `refreshSettings` 的 `cached = {...}` 里）有两个硬理由：
 *     ① 列**还没建**（`ALTER TABLE` 与设置页是另一件事）：缺列时 `r.context_window` 是 `undefined`，
 *        这条路径必须**不抛、不静默变成 0**，而"读不到就退回下一步解析"正是它要保证的语义；
 *     ② 纯函数才能被单测覆盖——DB 不在测试环境里，写进 `refreshSettings` 就只能靠真机验证。
 *   口径与邻居一致：`Number(x ?? 0) || null`（**0/空/垃圾 → null = 没配**）。
 *   注意这里**不**把 `"128k"` 这类串"聪明地"解析成数字（Number("128k") = NaN → null）：
 *   坏数据当没配，回落下一步并告警，比猜一个数安全。`resolveContextWindow` 还会再解析一次。
 */
export function readContextWindowColumns(row: Record<string, unknown> | null | undefined): {
    contextWindow: number | null;
    contextWindowPro: number | null;
} {
    if (!row) return { contextWindow: null, contextWindowPro: null };
    return {
        contextWindow: Number(row["context_window"] ?? 0) || null,
        contextWindowPro: Number(row["context_window_pro"] ?? 0) || null,
    };
}

let cached: RtSettings | null = null;
let loadedAt = 0;
const TTL_MS = 30_000;

/** 拉取 sys_settings（id=1 单行）。force=true 跳缓存；失败静默保旧值 */
export async function refreshSettings(force = false): Promise<void> {
    if (cached && !force && Date.now() - loadedAt < TTL_MS) return;
    try {
        const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM sys_settings WHERE id = 1");
        const r = rows[0] as Record<string, unknown> | undefined;
        if (r) {
            // 窗口两列走独立纯函数（缺列/垃圾 → null = 没配，交给下一步解析并告警）
            const window = readContextWindowColumns(r);
            cached = {
                modelName: (r.model_name as string)?.trim() || null,
                modelPro: (r.model_pro as string)?.trim() || null,
                roleModels: (r.role_models as string)?.trim() || null,   // 列缺失（迁移未跑）=null → models.ts 回落内置档位表
                modelUrl: (r.model_url as string)?.trim() || null,
                apiKey: (r.api_key as string)?.trim() || null,
                modelKind: (r.model_kind as string)?.trim() || "deepseek",
                javaBaseUrl: (r.java_base_url as string)?.trim() || "http://localhost:8080",
                confirmTimeoutMin: Number(r.confirm_timeout_min ?? 30) || 30,
                smokeBuild: Number(r.smoke_build ?? 0) === 1,
                llmConcurrency: Number(r.llm_concurrency ?? 6) || 6,
                stationSlots: Number(r.station_slots ?? 5) || 5,
                toolMode: Number(r.tool_mode ?? 0) === 1,   // 列缺失=关（旁路：默认走验证过的老路）
                contextWindow: window.contextWindow,        // 列缺失（迁移未跑）=null → 引擎回落下一步并告警
                contextWindowPro: window.contextWindowPro,
            };
            loadedAt = Date.now();
        }
    } catch (e) {
        console.warn("[settings] sys_settings 读取失败（按 .env/内置配置继续）:", (e as Error).message);
    }
}

/** 同步读缓存（initModels 等热路径用；null=还没读到，走内置行为） */
export function runtimeSettings(): RtSettings | null {
    return cached;
}

/** 引擎→Java 回调基址（settings > .env JAVA_BASE_URL > localhost 默认） */
export function javaBaseUrl(): string {
    return cached?.javaBaseUrl || process.env.JAVA_BASE_URL?.trim() || "http://localhost:8080";
}
