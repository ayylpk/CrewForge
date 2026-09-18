// ============================================================
// state.ts —— 状态机（纯函数，零 LLM 零 IO）
//
//   不变量（主计划 §1.2）在这里落成代码：
//     · 0 产物 / 0 任务 = 失败，**永不 done**
//     · verified 只能由 evidence 计数推出（由调用方在拿到 exec 证据后调用）
//     · 迁移非法即抛错（不允许"悄悄跳到 done"）
// ============================================================

export type FailureClass = "COMPILE" | "CONTRACT" | "TEST" | "ENV" | "SPEC" | "BUDGET" | "UNKNOWN";

export type SliceState =
    | { s: "planned" }
    | { s: "contracted"; contractRef: string }
    | { s: "implemented"; attempt: number }
    /** ★ 只有带证据才能到达（evidenceCount>0）；由 exec 层产出证据后调用 */
    | { s: "verified"; evidenceCount: number }
    | { s: "blocked"; reason: FailureClass; detail: string }
    | { s: "done"; inputHash: string };

export type SlicePhase = SliceState["s"];

export type SliceEvent =
    | { e: "contract"; contractRef: string }
    | { e: "implement"; attempt: number }
    | { e: "verify"; evidenceCount: number }
    | { e: "finish"; inputHash: string }
    | { e: "block"; reason: FailureClass; detail: string }
    | { e: "retry" };

/** 合法迁移表（改这张表=改语义，必须同步更新 run-smoke 断言） */
export const SLICE_TRANSITIONS: Record<SlicePhase, SlicePhase[]> = {
    planned: ["contracted", "blocked"],
    contracted: ["implemented", "blocked"],
    implemented: ["verified", "blocked"],
    verified: ["done", "blocked"],
    blocked: ["contracted", "implemented", "blocked"],   // 返工可回到任一步继续
    done: [],                                            // 终态
};

export function canTransition(from: SlicePhase, to: SlicePhase): boolean {
    return (SLICE_TRANSITIONS[from] ?? []).includes(to);
}

/** 迁移：非法即抛错（调用方不许静默兜底） */
export function advance(cur: SliceState, ev: SliceEvent): SliceState {
    let next: SliceState;
    switch (ev.e) {
        case "contract": next = { s: "contracted", contractRef: ev.contractRef }; break;
        case "implement": next = { s: "implemented", attempt: ev.attempt }; break;
        case "verify":
            if (ev.evidenceCount <= 0) throw new Error("非法迁移：evidenceCount<=0 不允许进入 verified（无证据=未验证）");
            next = { s: "verified", evidenceCount: ev.evidenceCount };
            break;
        case "finish": next = { s: "done", inputHash: ev.inputHash }; break;
        case "block": next = { s: "blocked", reason: ev.reason, detail: ev.detail }; break;
        case "retry": next = { s: "implemented", attempt: 2 }; break;
        default: throw new Error(`未知事件 ${JSON.stringify(ev)}`);
    }
    if (!canTransition(cur.s, next.s)) {
        throw new Error(`非法状态迁移：${cur.s} → ${next.s}`);
    }
    return next;
}

export function isSliceDone(s: SliceState): boolean { return s.s === "done"; }

/** 项目级结论：★ 空集合不是完成；全部 done 才算完成 */
export function projectVerdict(slices: SliceState[]): { done: boolean; reason: string } {
    if (slices.length === 0) return { done: false, reason: "0 个切片 = 没有产出，不算完成" };
    const blocked = slices.filter(x => x.s === "blocked").length;
    const incomplete = slices.filter(x => x.s !== "done").length;
    if (incomplete === 0) return { done: true, reason: `${slices.length} 个切片全部 done` };
    return { done: false, reason: `${incomplete}/${slices.length} 个切片未完成（其中 blocked ${blocked}）` };
}

// ---------- 项目级终态（★ 阶段 1 提交 1：唯一判据，纯函数零 IO） ----------

/**
 * 项目终态。`blocked` = 机器判定不出来（例如无 Docker/无验证器）——
 * **未验证 ≠ 通过**，所以它绝不能折叠成 done。
 */
export type ProjectStatus = "done" | "failed" | "blocked";

export interface CompletionInput {
    /** sys_task 行数（0 = 一个任务都没拆出来） */
    taskCount: number;
    /** 产物树里的文件数（0 = 什么都没产出） */
    artifactCount: number;
    /** 定论为 failed 的任务数 */
    failedTaskCount: number;
    /** 交付关结论：done / failed / blocked / skipped_unverified */
    finalGateStatus: string;
    /** 交付关是否真的跑过执行式验证并通过 */
    verified: boolean;
    /** 必需断言（冻结场景的 HTTP/渲染断言）是否全过 */
    requiredAssertionsPassed: boolean;
}

/**
 * 唯一终态函数（阶段 1 硬规则）：
 *   · 0 任务 / 0 产物 = failed（永不 done）
 *   · 有 failed 任务 = failed
 *   · skipped_unverified（Docker/验证器缺失）= blocked，**不得转换成 done**
 *   · 只有 finalGate=done + verified=true + 必需断言全过，才允许 done
 */
export function decideProjectStatus(input: CompletionInput): ProjectStatus {
    if (input.taskCount === 0 || input.artifactCount === 0) return "failed";
    if (input.failedTaskCount > 0) return "failed";
    if (input.finalGateStatus === "skipped_unverified") return "blocked";
    if (input.finalGateStatus !== "done") return "failed";
    if (!input.verified || !input.requiredAssertionsPassed) return "failed";
    return "done";
}

/** 终态理由（逐条可读，进报告；判定不看它） */
export function completionReasons(input: CompletionInput): string[] {
    const reasons: string[] = [];
    if (input.taskCount === 0) reasons.push("0 个任务 = 没有产出，永不 done");
    if (input.artifactCount === 0) reasons.push("0 个产物 = 没有产出，永不 done");
    if (input.failedTaskCount > 0) reasons.push(`有 ${input.failedTaskCount} 个任务 failed`);
    if (input.finalGateStatus === "skipped_unverified") reasons.push("交付关为 skipped_unverified（未验证 ≠ 通过）");
    else if (input.finalGateStatus !== "done") reasons.push(`交付关结论为 ${input.finalGateStatus}`);
    if (input.finalGateStatus === "done" && !input.verified) reasons.push("交付关未 verified");
    if (!input.requiredAssertionsPassed) reasons.push("必需断言未全部通过");
    if (reasons.length === 0) reasons.push(`全部条件满足（任务 ${input.taskCount} / 产物 ${input.artifactCount} / 断言全过 / verified）`);
    return reasons;
}

// ---------- step 级 ----------

export type StepStatus = "pending" | "running" | "ok" | "failed";

export interface StepRecord {
    id: string;
    runId: string;
    kind: string;
    sliceId: string | null;
    inputHash: string;
    status: StepStatus;
    attempts: number;
    leaseUntil: number | null;
    workerId: string | null;
    resultJson: string | null;
    evidenceJson: string | null;
    error: string | null;
    durationMs: number | null;
    updatedAt: number;
}

export function stepId(runId: string, kind: string, sliceId?: string | null): string {
    return `${runId}:${sliceId ?? "-"}:${kind}`;
}

/** 稳定哈希（FNV-1a 32bit）：输入变了才重跑，输入没变直接吃缓存 */
export function hashInput(parts: unknown): string {
    const text = JSON.stringify(parts, (_k, v) => (v === undefined ? null : v));
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
}

/** 租约是否可回收（进程被杀 → 租约到期 → 别人可接手） */
export function isReclaimable(rec: StepRecord, now = Date.now()): boolean {
    if (rec.status === "pending" || rec.status === "failed") return true;
    if (rec.status === "running") return rec.leaseUntil == null || rec.leaseUntil < now;
    return false;
}
