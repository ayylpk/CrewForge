// ============================================================
// store.ts —— 持久化步骤表（Ledger 脊柱，零 LLM）
//
//   为什么必须落盘：现有的"断点续跑"靠 sys_task 表 + .architect-state.json 两个临时落点拼凑，
//   而工位的判定计数是内存 Map——**进程一死全部重来**。这里把状态与缓存放到磁盘上：
//     · step 幂等：同一 (run,slice,kind) 只有一行；inputHash 一致且 ok → 直接吃缓存
//     · 租约（leaseUntil）：进程被杀 → 租约到期 → 可被回收，不需要"谁记得"
//     · 事件流：类型化追加写（M8 的报告页唯一数据源）
//
//   实现：bun:sqlite（Bun 内置，零依赖）。MySQL 适配留给桌面/服务端批次，接口不变。
// ============================================================

import { Database } from "bun:sqlite";
import type { StepRecord, StepStatus } from "./state";

export interface StepStore {
    getStep(id: string): StepRecord | null;
    /** 登记（已存在则不动）：幂等，重复调用安全 */
    ensureStep(rec: { id: string; runId: string; kind: string; sliceId?: string | null; inputHash: string }): StepRecord;
    /** 抢租约：成功=由本 worker 执行；失败=别人在跑或已完成 */
    claim(id: string, workerId: string, leaseMs: number): boolean;
    finish(id: string, status: StepStatus, patch?: { resultJson?: string | null; evidenceJson?: string | null; error?: string | null; durationMs?: number }): void;
    /** 缓存命中判定：同 inputHash 且 ok */
    isCachedOk(id: string, inputHash: string): boolean;
    listByRun(runId: string): StepRecord[];
    setSliceState(runId: string, sliceId: string, stateJson: string): void;
    getSliceStates(runId: string): { sliceId: string; stateJson: string }[];
    appendEvent(runId: string, type: string, payloadJson: string): void;
    listEvents(runId: string): { type: string; payloadJson: string; at: number }[];
    close(): void;
}

function rowToStep(r: any): StepRecord {
    return {
        id: r.id, runId: r.run_id, kind: r.kind, sliceId: r.slice_id, inputHash: r.input_hash,
        status: r.status, attempts: r.attempts, leaseUntil: r.lease_until, workerId: r.worker_id,
        resultJson: r.result_json, evidenceJson: r.evidence_json, error: r.error,
        durationMs: r.duration_ms, updatedAt: r.updated_at,
    };
}

export class SqliteStepStore implements StepStore {
    private readonly db: Database;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        this.db.exec("PRAGMA journal_mode = WAL;");
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS run (
                run_id TEXT PRIMARY KEY, project_id INTEGER, state TEXT NOT NULL, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS step (
                id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, slice_id TEXT,
                input_hash TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
                lease_until INTEGER, worker_id TEXT, result_json TEXT, evidence_json TEXT, error TEXT,
                duration_ms INTEGER, updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_step_run ON step(run_id);
            CREATE TABLE IF NOT EXISTS slice_state (
                run_id TEXT NOT NULL, slice_id TEXT NOT NULL, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
                PRIMARY KEY (run_id, slice_id)
            );
            CREATE TABLE IF NOT EXISTS run_event (
                id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, at INTEGER NOT NULL
            );
        `);
    }

    getStep(id: string): StepRecord | null {
        const r = this.db.query("SELECT * FROM step WHERE id = ?").get(id) as any;
        return r ? rowToStep(r) : null;
    }

    ensureStep(rec: { id: string; runId: string; kind: string; sliceId?: string | null; inputHash: string }): StepRecord {
        const now = Date.now();
        this.db.query(`INSERT OR IGNORE INTO step (id, run_id, kind, slice_id, input_hash, status, attempts, updated_at)
                       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`)
            .run(rec.id, rec.runId, rec.kind, rec.sliceId ?? null, rec.inputHash, now);
        return this.getStep(rec.id)!;
    }

    /** 抢租约：pending/failed 直接可抢；running 但租约过期也可抢（崩溃回收）；ok 不可抢 */
    claim(id: string, workerId: string, leaseMs: number): boolean {
        const now = Date.now();
        const res = this.db.query(`
            UPDATE step SET status='running', worker_id=?, lease_until=?, attempts=attempts+1, updated_at=?
            WHERE id=? AND (status IN ('pending','failed') OR (status='running' AND (lease_until IS NULL OR lease_until < ?)))
        `).run(workerId, now + leaseMs, now, id, now);
        return Number(res.changes ?? 0) > 0;
    }

    finish(id: string, status: StepStatus, patch: { resultJson?: string | null; evidenceJson?: string | null; error?: string | null; durationMs?: number } = {}): void {
        this.db.query(`UPDATE step SET status=?, result_json=?, evidence_json=?, error=?, duration_ms=?, lease_until=NULL, worker_id=NULL, updated_at=? WHERE id=?`)
            .run(status, patch.resultJson ?? null, patch.evidenceJson ?? null, patch.error ?? null, patch.durationMs ?? null, Date.now(), id);
    }

    isCachedOk(id: string, inputHash: string): boolean {
        const r = this.getStep(id);
        return !!r && r.status === "ok" && r.inputHash === inputHash;
    }

    listByRun(runId: string): StepRecord[] {
        return (this.db.query("SELECT * FROM step WHERE run_id = ? ORDER BY id").all(runId) as any[]).map(rowToStep);
    }

    setSliceState(runId: string, sliceId: string, stateJson: string): void {
        this.db.query(`INSERT INTO slice_state (run_id, slice_id, state_json, updated_at) VALUES (?, ?, ?, ?)
                       ON CONFLICT(run_id, slice_id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at`)
            .run(runId, sliceId, stateJson, Date.now());
    }

    getSliceStates(runId: string): { sliceId: string; stateJson: string }[] {
        return (this.db.query("SELECT slice_id, state_json FROM slice_state WHERE run_id = ? ORDER BY slice_id").all(runId) as any[])
            .map(r => ({ sliceId: r.slice_id, stateJson: r.state_json }));
    }

    appendEvent(runId: string, type: string, payloadJson: string): void {
        this.db.query("INSERT INTO run_event (run_id, type, payload_json, at) VALUES (?, ?, ?, ?)")
            .run(runId, type, payloadJson, Date.now());
    }

    listEvents(runId: string): { type: string; payloadJson: string; at: number }[] {
        return (this.db.query("SELECT type, payload_json, at FROM run_event WHERE run_id = ? ORDER BY id").all(runId) as any[])
            .map(r => ({ type: r.type, payloadJson: r.payload_json, at: r.at }));
    }

    close(): void { this.db.close(); }
}
