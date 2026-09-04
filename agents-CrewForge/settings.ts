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
    /** 全局模型名（设置页一旦填写即覆盖所有角色内置名；按角色分档是 v3 T3 的事） */
    modelName: string | null;
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
            cached = {
                modelName: (r.model_name as string)?.trim() || null,
                modelUrl: (r.model_url as string)?.trim() || null,
                apiKey: (r.api_key as string)?.trim() || null,
                modelKind: (r.model_kind as string)?.trim() || "deepseek",
                javaBaseUrl: (r.java_base_url as string)?.trim() || "http://localhost:8080",
                confirmTimeoutMin: Number(r.confirm_timeout_min ?? 30) || 30,
                smokeBuild: Number(r.smoke_build ?? 0) === 1,
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
