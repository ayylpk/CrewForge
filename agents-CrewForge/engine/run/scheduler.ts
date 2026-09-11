// ============================================================
// scheduler.ts —— 有界调度 + 幂等重放（M2，零 LLM）
//
//   行为契约：
//     · 同 inputHash 且已 ok 的 step → **不重跑**（吃缓存），记入 cached
//     · 租约过期（进程被杀）→ 可被回收重跑，记入 reclaimed
//     · 别人正持有租约 → skippedBusy（不抢、不阻塞）
//     · 预算耗尽 / 外部熔断 → 立刻停，剩余 step 保持 pending（**不许假装完成**）
// ============================================================

import type { StepStore } from "./store";
import { stepId, hashInput, isReclaimable } from "./state";

export interface StepTask {
    kind: string;
    sliceId?: string | null;
    /** 参与 inputHash 的输入（文件集 / 契约 / 命令 / 配置） */
    input: unknown;
    /** 执行体：返回 ok=false 即失败；抛异常按失败处理（消息进 error） */
    run: () => Promise<{ ok: boolean; result?: unknown; evidence?: unknown; error?: string }>;
}

export interface RunStepsResult {
    executed: string[];
    cached: string[];
    failed: string[];
    skippedBusy: string[];
    reclaimed: string[];
    budgetExceeded: boolean;
}

export interface RunStepsOpts {
    store: StepStore;
    runId: string;
    workerId: string;
    tasks: StepTask[];
    concurrency?: number;
    leaseMs?: number;
    budget?: { maxSteps?: number; maxWallMs?: number };
    /** 任务之间检查：返回 true 立即停（外部预算熔断/用户取消） */
    shouldStop?: () => boolean;
    onEvent?: (type: string, payload: Record<string, unknown>) => void;
}

export async function runSteps(o: RunStepsOpts): Promise<RunStepsResult> {
    const startedAt = Date.now();
    const leaseMs = o.leaseMs ?? 60_000;
    const concurrency = Math.max(1, o.concurrency ?? 4);
    const out: RunStepsResult = { executed: [], cached: [], failed: [], skippedBusy: [], reclaimed: [], budgetExceeded: false };
    let cursor = 0;

    // ★ 先登记全部 step：Ledger 的意义之一就是"还剩什么没做"。
    //   若因预算熔断提前停，未执行的 step 会如实保持 pending（未执行 ≠ 完成）。
    for (const t of o.tasks) {
        o.store.ensureStep({
            id: stepId(o.runId, t.kind, t.sliceId),
            runId: o.runId, kind: t.kind, sliceId: t.sliceId ?? null,
            inputHash: hashInput(t.input),
        });
    }

    const budgetStop = (): boolean => {
        if (o.budget?.maxSteps != null && out.executed.length >= o.budget.maxSteps) return true;
        if (o.budget?.maxWallMs != null && Date.now() - startedAt >= o.budget.maxWallMs) return true;
        if (o.shouldStop?.()) return true;
        return false;
    };

    const worker = async (): Promise<void> => {
        for (;;) {
            if (budgetStop()) { out.budgetExceeded = true; return; }
            const idx = cursor++;
            const task = o.tasks[idx];
            if (!task) return;

            const id = stepId(o.runId, task.kind, task.sliceId);
            const inputHash = hashInput(task.input);
            o.store.ensureStep({ id, runId: o.runId, kind: task.kind, sliceId: task.sliceId ?? null, inputHash });

            if (o.store.isCachedOk(id, inputHash)) {
                out.cached.push(id);
                o.onEvent?.("step_cached", { id, kind: task.kind });
                continue;
            }
            const before = o.store.getStep(id);
            if (!o.store.claim(id, o.workerId, leaseMs)) {
                out.skippedBusy.push(id);
                o.onEvent?.("step_busy", { id, holder: before?.workerId ?? null });
                continue;
            }
            const wasReclaim = !!before && before.status === "running" && isReclaimable(before);
            if (wasReclaim) out.reclaimed.push(id);

            const t0 = Date.now();
            try {
                const r = await task.run();
                o.store.finish(id, r.ok ? "ok" : "failed", {
                    resultJson: r.result === undefined ? null : JSON.stringify(r.result),
                    evidenceJson: r.evidence === undefined ? null : JSON.stringify(r.evidence),
                    error: r.ok ? null : (r.error ?? "未给原因"),
                    durationMs: Date.now() - t0,
                });
                if (r.ok) out.executed.push(id); else out.failed.push(id);
                o.onEvent?.(r.ok ? "step_ok" : "step_failed", { id, kind: task.kind, error: r.error ?? null, durationMs: Date.now() - t0 });
            } catch (e) {
                o.store.finish(id, "failed", { error: String((e as Error).message ?? e).slice(0, 400), durationMs: Date.now() - t0 });
                out.failed.push(id);
                o.onEvent?.("step_failed", { id, kind: task.kind, error: String((e as Error).message ?? e).slice(0, 400) });
            }
        }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, o.tasks.length) }, () => worker()));
    return out;
}
