// ============================================================
// ledger.ts —— Developer 的持久化账本（bun:sqlite / WAL）
//
//   规格要求「所有状态进入 Ledger」「崩溃后可以从 Ledger 恢复」，所以这里落五类事实：
//     · node_event   节点进入 / 退出
//     · tool_call    每次工具调用（参数哈希、结果哈希、退出码、改动文件）
//     · failure      失败签名与修复尝试
//     · event        其余事件（消息收发、决策、阻断原因）
//     · task_state   任务级快照（状态 / 修复次数 / 失败签名 / 改动文件 / LLM 调用数）
//     · seen_message 已处理消息键（Hub 重复投递幂等）
//
//   分工铁律：Ledger 是**状态真相**；LangGraph State 只是图内执行上下文。
// ============================================================

import { Database } from "bun:sqlite";
import fs from "node:fs";

/** 稳定哈希（FNV-1a 32bit → 8 位十六进制），与 engine2 同款，便于对照 */
export function hashOf(parts: unknown): string {
    const text = JSON.stringify(parts, (_k, v) => (v === undefined ? null : v));
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
}

/** 建目录（幂等）：Bun 的 mkdirSync 在目录已存在时可能抛 EEXIST，这里统一吞掉 */
export function ensureDir(dir: string): void {
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
        if ((e as { code?: string }).code !== "EEXIST") throw e;
    }
}

export interface ToolCallRecord {
    taskId: string;
    toolName: string;
    argumentsHash: string;
    resultHash: string;
    startedAt: number;
    finishedAt: number;
    exitCode: number | null;
    changedFiles: string[];
    ok: boolean;
}

export interface FailureRecord {
    taskId: string;
    attempt: number;
    signature: string;
    category: string;
    detail: string;
    at: number;
}

export interface TaskSnapshot {
    taskId: string;
    status: string;
    repairAttempts: number;
    failureSignatures: string[];
    changedFiles: string[];
    llmCalls: number;
    updatedAt: number;
}

/** 节点级 checkpoint 记录（规格四） */
export interface CheckpointRecord {
    taskId: string;
    node: string;
    phase: "enter" | "exit";
    status: string;
    /** 恢复时应从哪个节点接着跑 */
    resumeNode: string | null;
    correlationId: string | null;
    /** 任务上下文指纹（任务包变了就不能拿旧 checkpoint 续跑） */
    contextHash: string;
    changedFiles: string[];
    failureSignatures: string[];
    repairAttempts: number;
    stalledRepairs: number;
    llmCallsPlanned: number;
    llmCallsCompleted: number;
    toolCalls: number;
}

export class DeveloperLedger {
    private constructor(private readonly db: Database, readonly runKey: string) { }

    static open(dbPath: string, runKey: string): DeveloperLedger {
        const db = new Database(dbPath);
        db.exec("PRAGMA journal_mode = WAL;");
        db.exec(`
            CREATE TABLE IF NOT EXISTS node_event (
                id INTEGER PRIMARY KEY AUTOINCREMENT, run_key TEXT NOT NULL, node TEXT NOT NULL,
                phase TEXT NOT NULL, status TEXT, payload_json TEXT NOT NULL, at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tool_call (
                id INTEGER PRIMARY KEY AUTOINCREMENT, run_key TEXT NOT NULL, task_id TEXT NOT NULL,
                tool_name TEXT NOT NULL, arguments_hash TEXT NOT NULL, result_hash TEXT NOT NULL,
                started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL, exit_code INTEGER,
                changed_files_json TEXT NOT NULL, ok INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS failure (
                id INTEGER PRIMARY KEY AUTOINCREMENT, run_key TEXT NOT NULL, task_id TEXT NOT NULL,
                attempt INTEGER NOT NULL, signature TEXT NOT NULL, category TEXT NOT NULL,
                detail TEXT NOT NULL, at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS event (
                id INTEGER PRIMARY KEY AUTOINCREMENT, run_key TEXT NOT NULL, type TEXT NOT NULL,
                payload_json TEXT NOT NULL, at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS task_state (
                run_key TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL,
                repair_attempts INTEGER NOT NULL, failure_signatures_json TEXT NOT NULL,
                changed_files_json TEXT NOT NULL, llm_calls INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS seen_message (
                run_key TEXT NOT NULL, msg_key TEXT NOT NULL, at INTEGER NOT NULL,
                PRIMARY KEY (run_key, msg_key)
            );
            CREATE TABLE IF NOT EXISTS checkpoint (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_key TEXT NOT NULL, task_id TEXT NOT NULL,
                node TEXT NOT NULL, phase TEXT NOT NULL,
                status TEXT NOT NULL,
                resume_node TEXT, correlation_id TEXT,
                context_hash TEXT NOT NULL,
                changed_files_json TEXT NOT NULL DEFAULT '[]',
                failure_signatures_json TEXT NOT NULL DEFAULT '[]',
                repair_attempts INTEGER NOT NULL DEFAULT 0,
                stalled_repairs INTEGER NOT NULL DEFAULT 0,
                llm_calls_planned INTEGER NOT NULL DEFAULT 0,
                llm_calls_completed INTEGER NOT NULL DEFAULT 0,
                tool_calls INTEGER NOT NULL DEFAULT 0,
                at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_checkpoint_run ON checkpoint(run_key, id);
            CREATE TABLE IF NOT EXISTS completed_tool_call (
                run_key TEXT NOT NULL, call_key TEXT NOT NULL,
                tool_name TEXT NOT NULL, ok INTEGER NOT NULL,
                output TEXT NOT NULL, meta_json TEXT NOT NULL, at INTEGER NOT NULL,
                PRIMARY KEY (run_key, call_key)
            );
            CREATE TABLE IF NOT EXISTS test_wait (
                run_key TEXT PRIMARY KEY, correlation_id TEXT NOT NULL,
                acceptance_hash TEXT NOT NULL, deadline_at INTEGER NOT NULL, created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS process_event (
                id INTEGER PRIMARY KEY AUTOINCREMENT, run_key TEXT NOT NULL, task_id TEXT NOT NULL,
                kind TEXT NOT NULL, process_id TEXT, pid INTEGER, command TEXT, args_json TEXT NOT NULL,
                detail_json TEXT NOT NULL, at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_process_event_run ON process_event(run_key, id);
            CREATE TABLE IF NOT EXISTS violation (
                id INTEGER PRIMARY KEY AUTOINCREMENT, run_key TEXT NOT NULL, task_id TEXT NOT NULL,
                code TEXT NOT NULL, target TEXT NOT NULL, message TEXT NOT NULL, at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS timeout_extension (
                run_key TEXT NOT NULL, fingerprint TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL,
                PRIMARY KEY (run_key, fingerprint)
            );
            CREATE TABLE IF NOT EXISTS subagent_call (
                run_key TEXT NOT NULL, task_id TEXT NOT NULL, signature TEXT NOT NULL,
                role TEXT NOT NULL, snapshot_hash TEXT NOT NULL, status TEXT NOT NULL,
                result_json TEXT, invoked_at INTEGER NOT NULL, settled_at INTEGER,
                PRIMARY KEY (run_key, task_id, signature)
            );
        `);
        return new DeveloperLedger(db, runKey);
    }

    close(): void { this.db.close(); }

    // ---------- checkpoint（规格四：节点级崩溃恢复） ----------

    writeCheckpoint(rec: CheckpointRecord): void {
        this.db.query(`INSERT INTO checkpoint
            (run_key, task_id, node, phase, status, resume_node, correlation_id, context_hash,
             changed_files_json, failure_signatures_json, repair_attempts, stalled_repairs,
             llm_calls_planned, llm_calls_completed, tool_calls, at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            this.runKey, rec.taskId, rec.node, rec.phase, rec.status,
            rec.resumeNode ?? null, rec.correlationId ?? null, rec.contextHash,
            JSON.stringify(rec.changedFiles), JSON.stringify(rec.failureSignatures),
            rec.repairAttempts, rec.stalledRepairs,
            rec.llmCallsPlanned, rec.llmCallsCompleted, rec.toolCalls, Date.now(),
        );
    }

    /** 最近一条 checkpoint —— 恢复的起点 */
    latestCheckpoint(): CheckpointRecord | null {
        const r = this.db.query("SELECT * FROM checkpoint WHERE run_key = ? ORDER BY id DESC LIMIT 1")
            .get(this.runKey) as any;
        if (!r) return null;
        return {
            taskId: r.task_id, node: r.node, phase: r.phase, status: r.status,
            resumeNode: r.resume_node, correlationId: r.correlation_id,
            contextHash: r.context_hash,
            changedFiles: JSON.parse(r.changed_files_json) as string[],
            failureSignatures: JSON.parse(r.failure_signatures_json) as string[],
            repairAttempts: r.repair_attempts, stalledRepairs: r.stalled_repairs,
            llmCallsPlanned: r.llm_calls_planned, llmCallsCompleted: r.llm_calls_completed,
            toolCalls: r.tool_calls,
        };
    }

    // ---------- 工具调用去重（规格四：恢复时不重复执行已完成调用） ----------

    /** true = 首次执行；false = 命中缓存（恢复场景，调用方应直接用缓存结果，不重复写盘） */
    recordToolCallOnce(callKey: string, toolName: string, ok: boolean, output: string, meta: unknown): boolean {
        const res = this.db.query(`INSERT OR IGNORE INTO completed_tool_call
            (run_key, call_key, tool_name, ok, output, meta_json, at) VALUES (?,?,?,?,?,?,?)`)
            .run(this.runKey, callKey, toolName, ok ? 1 : 0, output, JSON.stringify(meta ?? null), Date.now());
        return Number(res.changes ?? 0) > 0;
    }

    cachedToolCall(callKey: string): { toolName: string; ok: boolean; output: string; meta: unknown } | null {
        const r = this.db.query("SELECT * FROM completed_tool_call WHERE run_key = ? AND call_key = ?")
            .get(this.runKey, callKey) as any;
        if (!r) return null;
        return { toolName: r.tool_name, ok: r.ok === 1, output: r.output, meta: JSON.parse(r.meta_json) as unknown };
    }

    // ---------- event ----------

    appendEvent(type: string, payload: unknown): void {
        this.db.query("INSERT INTO event (run_key, type, payload_json, at) VALUES (?, ?, ?, ?)")
            .run(this.runKey, type, JSON.stringify(payload ?? null), Date.now());
    }

    listEvents(): { type: string; payload: unknown; at: number }[] {
        return (this.db.query("SELECT type, payload_json, at FROM event WHERE run_key = ? ORDER BY id")
            .all(this.runKey) as { type: string; payload_json: string; at: number }[])
            .map((r) => ({ type: r.type, payload: JSON.parse(r.payload_json) as unknown, at: r.at }));
    }

    // ---------- node ----------

    enterNode(node: string, status: string | null = null): void {
        this.db.query("INSERT INTO node_event (run_key, node, phase, status, payload_json, at) VALUES (?, ?, 'enter', ?, '{}', ?)")
            .run(this.runKey, node, status, Date.now());
    }

    exitNode(node: string, status: string | null = null, payload: unknown = null): void {
        this.db.query("INSERT INTO node_event (run_key, node, phase, status, payload_json, at) VALUES (?, ?, 'exit', ?, ?, ?)")
            .run(this.runKey, node, status, JSON.stringify(payload ?? null), Date.now());
    }

    listNodeEvents(): { node: string; phase: string; status: string | null; at: number }[] {
        return (this.db.query("SELECT node, phase, status, at FROM node_event WHERE run_key = ? ORDER BY id")
            .all(this.runKey) as { node: string; phase: string; status: string | null; at: number }[]);
    }

    // ---------- tool_call ----------

    recordToolCall(rec: ToolCallRecord): void {
        this.db.query(`INSERT INTO tool_call
            (run_key, task_id, tool_name, arguments_hash, result_hash, started_at, finished_at, exit_code, changed_files_json, ok)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            this.runKey, rec.taskId, rec.toolName, rec.argumentsHash, rec.resultHash,
            rec.startedAt, rec.finishedAt, rec.exitCode, JSON.stringify(rec.changedFiles), rec.ok ? 1 : 0,
        );
    }

    listToolCalls(): (ToolCallRecord & { at: number })[] {
        return (this.db.query("SELECT * FROM tool_call WHERE run_key = ? ORDER BY id").all(this.runKey) as any[])
            .map((r) => ({
                taskId: r.task_id, toolName: r.tool_name, argumentsHash: r.arguments_hash,
                resultHash: r.result_hash, startedAt: r.started_at, finishedAt: r.finished_at,
                exitCode: r.exit_code, changedFiles: JSON.parse(r.changed_files_json) as string[],
                ok: r.ok === 1, at: r.finished_at,
            }));
    }

    // ---------- failure ----------

    recordFailure(rec: FailureRecord): void {
        this.db.query(`INSERT INTO failure (run_key, task_id, attempt, signature, category, detail, at)
                       VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(this.runKey, rec.taskId, rec.attempt, rec.signature, rec.category, rec.detail, rec.at);
    }

    listFailures(): FailureRecord[] {
        return (this.db.query("SELECT * FROM failure WHERE run_key = ? ORDER BY id").all(this.runKey) as any[])
            .map((r) => ({
                taskId: r.task_id, attempt: r.attempt, signature: r.signature,
                category: r.category, detail: r.detail, at: r.at,
            }));
    }

    // ---------- task_state（崩溃恢复用） ----------

    saveState(snap: Omit<TaskSnapshot, "updatedAt">): void {
        this.db.query(`INSERT INTO task_state
            (run_key, task_id, status, repair_attempts, failure_signatures_json, changed_files_json, llm_calls, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_key) DO UPDATE SET
              task_id = excluded.task_id, status = excluded.status,
              repair_attempts = excluded.repair_attempts,
              failure_signatures_json = excluded.failure_signatures_json,
              changed_files_json = excluded.changed_files_json,
              llm_calls = excluded.llm_calls, updated_at = excluded.updated_at`).run(
            this.runKey, snap.taskId, snap.status, snap.repairAttempts,
            JSON.stringify(snap.failureSignatures), JSON.stringify(snap.changedFiles),
            snap.llmCalls, Date.now(),
        );
    }

    /** 崩溃恢复：读回任务快照（没有则返回 null = 全新任务） */
    loadState(): TaskSnapshot | null {
        const r = this.db.query("SELECT * FROM task_state WHERE run_key = ?").get(this.runKey) as any;
        if (!r) return null;
        return {
            taskId: r.task_id, status: r.status, repairAttempts: r.repair_attempts,
            failureSignatures: JSON.parse(r.failure_signatures_json) as string[],
            changedFiles: JSON.parse(r.changed_files_json) as string[],
            llmCalls: r.llm_calls, updatedAt: r.updated_at,
        };
    }

    // ---------- 测试等待窗口（规格三.10：超时由外部判 blocked） ----------

    /** 记下"正在等这个 correlationId 的测试结果，截止到 deadlineAt" */
    openTestWait(rec: { correlationId: string; acceptanceHash: string; deadlineAt: number }): void {
        this.db.query(`INSERT INTO test_wait (run_key, correlation_id, acceptance_hash, deadline_at, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(run_key) DO UPDATE SET
              correlation_id = excluded.correlation_id,
              acceptance_hash = excluded.acceptance_hash,
              deadline_at = excluded.deadline_at,
              created_at = excluded.created_at`).run(
            this.runKey, rec.correlationId, rec.acceptanceHash, rec.deadlineAt, Date.now(),
        );
    }

    getTestWait(): { correlationId: string; acceptanceHash: string; deadlineAt: number; createdAt: number } | null {
        const r = this.db.query("SELECT * FROM test_wait WHERE run_key = ?").get(this.runKey) as any;
        if (!r) return null;
        return {
            correlationId: r.correlation_id, acceptanceHash: r.acceptance_hash,
            deadlineAt: r.deadline_at, createdAt: r.created_at,
        };
    }

    clearTestWait(): void {
        this.db.query("DELETE FROM test_wait WHERE run_key = ?").run(this.runKey);
    }

    // ---------- 进程生命周期（规格五.9：启动 / 轮询 / 停止都必须入账） ----------

    recordProcessEvent(rec: {
        kind: string; taskId: string; processId: string | null; pid: number | null;
        command: string; args: string[]; detail: unknown;
    }): void {
        this.db.query(`INSERT INTO process_event
            (run_key, task_id, kind, process_id, pid, command, args_json, detail_json, at)
            VALUES (?,?,?,?,?,?,?,?,?)`).run(
            this.runKey, rec.taskId, rec.kind, rec.processId, rec.pid, rec.command,
            JSON.stringify(rec.args ?? []), JSON.stringify(rec.detail ?? null), Date.now(),
        );
    }

    listProcessEvents(): {
        kind: string; taskId: string; processId: string | null; pid: number | null;
        command: string; args: string[]; detail: unknown; at: number;
    }[] {
        return (this.db.query("SELECT * FROM process_event WHERE run_key = ? ORDER BY id").all(this.runKey) as any[])
            .map((r) => ({
                kind: r.kind, taskId: r.task_id, processId: r.process_id, pid: r.pid,
                command: r.command, args: JSON.parse(r.args_json) as string[],
                detail: JSON.parse(r.detail_json) as unknown, at: r.at,
            }));
    }

    // ---------- 违规留痕（沙箱边界被撞的记录） ----------

    recordViolation(rec: { code: string; target: string; message: string; taskId: string; at?: number }): void {
        this.db.query("INSERT INTO violation (run_key, task_id, code, target, message, at) VALUES (?,?,?,?,?,?)")
            .run(this.runKey, rec.taskId, rec.code, rec.target, rec.message, rec.at ?? Date.now());
    }

    listViolations(): { code: string; target: string; message: string; taskId: string; at: number }[] {
        return (this.db.query("SELECT * FROM violation WHERE run_key = ? ORDER BY id").all(this.runKey) as any[])
            .map((r) => ({ code: r.code, target: r.target, message: r.message, taskId: r.task_id, at: r.at }));
    }

    // ---------- 超时延长（规格五.7：最多一次，且必须记原因） ----------

    // ---------- 只读子 Agent 调用（规格六：去重 + 快照绑定 + 成本闸） ----------

    /**
     * 抢占一次子 Agent 调用名额。
     * true = 首次调用（可执行）；false = 同一 (taskId, signature) 已调用过（去重，不得再跑）。
     * 主键 = (run_key, task_id, signature)，与规格六.2「同一 failureSignature 最多调用一次」一一对应。
     */
    claimSubagentCall(rec: {
        taskId: string; signature: string; role: string; snapshotHash: string;
    }): boolean {
        const res = this.db.query(`INSERT OR IGNORE INTO subagent_call
            (run_key, task_id, signature, role, snapshot_hash, status, invoked_at)
            VALUES (?,?,?,?,?,?,?)`)
            .run(this.runKey, rec.taskId, rec.signature, rec.role, rec.snapshotHash, "running", Date.now());
        return Number(res.changes ?? 0) > 0;
    }

    /** 回填调用结果：status=done 带 result_json；failed/timeout 的 result_json 传 null（不可被当结论复用） */
    settleSubagentCall(rec: {
        taskId: string; signature: string; status: "done" | "failed" | "timeout"; result: unknown;
    }): void {
        this.db.query(`UPDATE subagent_call
            SET status = ?, result_json = ?, settled_at = ?
            WHERE run_key = ? AND task_id = ? AND signature = ?`)
            .run(
                rec.status,
                rec.status === "done" ? JSON.stringify(rec.result ?? null) : null,
                Date.now(), this.runKey, rec.taskId, rec.signature,
            );
    }

    /** 查同一 (taskId, signature) 的历史调用；没有则 null */
    subagentCall(taskId: string, signature: string): {
        role: string; snapshotHash: string; status: string; result: unknown; invokedAt: number;
    } | null {
        const r = this.db.query(`SELECT * FROM subagent_call
            WHERE run_key = ? AND task_id = ? AND signature = ?`)
            .get(this.runKey, taskId, signature) as any;
        if (!r) return null;
        return {
            role: r.role, snapshotHash: r.snapshot_hash, status: r.status,
            result: r.result_json ? JSON.parse(r.result_json) as unknown : null,
            invokedAt: r.invoked_at,
        };
    }

    /** 本 run 已发起的子 Agent 调用总数（成本闸用；失败/超时也计数，防止无限重试） */
    subagentCallCount(): number {
        const r = this.db.query("SELECT COUNT(*) AS n FROM subagent_call WHERE run_key = ?")
            .get(this.runKey) as { n?: number } | null;
        return r?.n ?? 0;
    }

    /** true = 本次延长被接受；false = 该命令已经延长过一次（同一指纹只许一次） */
    recordTimeoutExtension(fingerprint: string, reason: string): boolean {
        const res = this.db.query(`INSERT OR IGNORE INTO timeout_extension
            (run_key, fingerprint, reason, at) VALUES (?,?,?,?)`)
            .run(this.runKey, fingerprint, reason, Date.now());
        return Number(res.changes ?? 0) > 0;
    }

    timeoutExtension(fp: string): { reason: string; at: number } | null {
        const r = this.db.query("SELECT reason, at FROM timeout_extension WHERE run_key = ? AND fingerprint = ?")
            .get(this.runKey, fp) as any;
        return r ? { reason: r.reason, at: r.at } : null;
    }

    // ---------- 幂等 ----------

    /** 返回 true = 第一次见（可处理）；false = 重复投递（必须跳过，不要重复烧修复） */
    markSeen(msgKey: string): boolean {
        const res = this.db.query("INSERT OR IGNORE INTO seen_message (run_key, msg_key, at) VALUES (?, ?, ?)")
            .run(this.runKey, msgKey, Date.now());
        return Number(res.changes ?? 0) > 0;
    }

    hasSeen(msgKey: string): boolean {
        const r = this.db.query("SELECT 1 AS x FROM seen_message WHERE run_key = ? AND msg_key = ?").get(this.runKey, msgKey);
        return !!r;
    }

    // ---------- 完整性计数（给沙箱探针用） ----------

    /**
     * 关键表的行数快照。
     * 用途：命令执行前后各取一次，**只降不升**就说明有东西删改了 Ledger——
     * 这比监视 mtime 靠谱，因为宿主自己每写一条事件都会让 mtime 变。
     */
    integrityCounters(): Record<string, number> {
        const one = (table: string): number => {
            const r = this.db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE run_key = ?`)
                .get(this.runKey) as { n?: number } | null;
            return r?.n ?? 0;
        };
        return {
            "ledger:event": one("event"),
            "ledger:node_event": one("node_event"),
            "ledger:tool_call": one("tool_call"),
            "ledger:failure": one("failure"),
            "ledger:checkpoint": one("checkpoint"),
            "ledger:task_state": one("task_state"),
            "ledger:seen_message": one("seen_message"),
            "ledger:subagent_call": one("subagent_call"),
        };
    }
}

export function openDeveloperLedger(dbPath: string, runKey: string): DeveloperLedger {
    return DeveloperLedger.open(dbPath, runKey);
}
