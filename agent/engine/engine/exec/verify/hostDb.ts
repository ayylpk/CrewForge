// ============================================================
// hostDb.ts —— 宿主 MySQL 验证模式（★ 阶段 1：Docker 不可用时的落库方式）
//
//   为什么需要：run 级验证原本假设"库在容器里"。Docker daemon 不在线时，
//   verifyRun 只能 skipped_unverified → 项目永远到不了 verified=true（未验证 ≠ 通过）。
//   阶段 1 明确允许改用**宿主 MySQL**：本文件负责建库/清库，并把每一步的
//   真实结果做成证据（cmd + ok + 耗时 + 错误原文）。
//
//   ⚠️ 报告纪律：宿主验证必须在报告里写成"宿主验证（host）"，不得冒充容器隔离验证。
// ============================================================

import mysql from "mysql2/promise";

export interface HostDbConfig {
    host: string;
    port: number;
    user: string;
    password: string;
}

export interface HostDbResult {
    ok: boolean;
    /** 真实执行的 SQL/操作描述（进证据链） */
    cmd: string;
    database: string;
    durationMs: number;
    error?: string;
}

export function hostDbConfig(): HostDbConfig {
    return {
        host: process.env.CF_VERIFY_DB_HOST ?? process.env.DB_HOST ?? "127.0.0.1",
        port: Number(process.env.CF_VERIFY_DB_PORT ?? process.env.DB_PORT ?? 3306),
        user: process.env.CF_VERIFY_DB_USER ?? process.env.DB_USER ?? "root",
        password: process.env.CF_VERIFY_DB_PASSWORD ?? process.env.DB_PASSWORD ?? "",
    };
}

/** 宿主 MySQL 是否可连（真连一次，不猜） */
export async function hostDbAvailable(cfg: HostDbConfig = hostDbConfig()): Promise<{ ok: boolean; error?: string }> {
    try {
        const conn = await mysql.createConnection({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password });
        try { await conn.query("SELECT 1"); } finally { await conn.end(); }
        return { ok: true };
    } catch (e) {
        return { ok: false, error: String((e as Error).message ?? e).slice(0, 300) };
    }
}

const SAFE_DB = /^[a-z0-9_]+$/i;

/** 建一个本次验证专用的空库（**空库是刻意的**：等价于 finalGate 原来的空容器库） */
export async function createHostDatabase(name: string, cfg: HostDbConfig = hostDbConfig()): Promise<HostDbResult> {
    const t0 = Date.now();
    if (!SAFE_DB.test(name)) return { ok: false, cmd: `CREATE DATABASE ${name}`, database: name, durationMs: 0, error: "库名含非法字符，拒绝执行" };
    try {
        const conn = await mysql.createConnection({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password });
        try {
            await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
            await conn.query(`CREATE DATABASE \`${name}\` DEFAULT CHARSET utf8mb4`);
        } finally { await conn.end(); }
        return { ok: true, cmd: `mysql: DROP+CREATE DATABASE ${name} @ ${cfg.host}:${cfg.port}`, database: name, durationMs: Date.now() - t0 };
    } catch (e) {
        return { ok: false, cmd: `mysql: CREATE DATABASE ${name}`, database: name, durationMs: Date.now() - t0, error: String((e as Error).message ?? e).slice(0, 300) };
    }
}

/** 删掉本次验证的库（幂等；退出必清理） */
export async function dropHostDatabase(name: string, cfg: HostDbConfig = hostDbConfig()): Promise<HostDbResult> {
    const t0 = Date.now();
    if (!SAFE_DB.test(name)) return { ok: false, cmd: `DROP DATABASE ${name}`, database: name, durationMs: 0, error: "库名含非法字符，拒绝执行" };
    try {
        const conn = await mysql.createConnection({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password });
        try { await conn.query(`DROP DATABASE IF EXISTS \`${name}\``); } finally { await conn.end(); }
        return { ok: true, cmd: `mysql: DROP DATABASE ${name}`, database: name, durationMs: Date.now() - t0 };
    } catch (e) {
        return { ok: false, cmd: `mysql: DROP DATABASE ${name}`, database: name, durationMs: Date.now() - t0, error: String((e as Error).message ?? e).slice(0, 300) };
    }
}

/** 供应用启动用的 JDBC 连接串 */
export function jdbcUrl(cfg: HostDbConfig, database: string): string {
    return `jdbc:mysql://${cfg.host}:${cfg.port}/${database}?useSSL=false&serverTimezone=UTC&allowPublicKeyRetrieval=true&characterEncoding=utf8`;
}
