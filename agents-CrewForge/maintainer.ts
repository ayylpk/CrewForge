// ============================================================
// maintainer.ts —— 维护（单例 "maintainer"，纯程序零 LLM）
//
//   集合收敛：架构师声明(final) + 每个任务 id 都有定论(通过/放弃) → 阶段完成
//   → phase_done 给架构师（架构师转告 PM 请求下一阶段）
//
//   9/15 新链路：前后端 pair 被 developerAgent 单开发流取代，merger 退役。
//   本文件收 developer 的三个出站终态（冻结契约 developerAgent/protocol.ts）：
//     developer_ready   → sys_task done
//     developer_blocked → sys_task failed（reason + failureSignature 进 error_msg）
//     developer_failed  → sys_task failed（error 进 error_msg）
//   收敛判据做兼容（两种形状都认）：定论 id 空间 = declared ∪ developer 终态，
//   全部定论且 final 已声明 → phase_done。
//
//   旧 task_passed/task_failed（testEngineer/merger）路径保留——回滚保险。
//
//   sys_task 写入面抽成可注入 sink（defaultTaskLedgerSink 走 task.ts 旁路写），
//   单测注 fake 即可零 DB 驱动；MySQL 未启动时也能测记账逻辑。
//
// 完成标准不预定义 N：声明可动态追加，final=true 表示本阶段不再有任务
// ============================================================

import { BaseAgent } from "./BaseAgent";
import { roles, type TransferStation } from "./Hub";
import { currentProjectId } from "./runEnv";
import { updateStatusByExt } from "./task";

/**
 * sys_task 写入面（可注入）：与 task.ts updateStatusByExt 同签名同语义
 * （无行静默跳过、DB 异常只 warn 不阻塞——桥是可观测层不是控制层）。
 * 默认实现直连 task.ts；测试注 fake 收集调用记录，零 DB。
 */
export interface TaskLedgerSink {
    setExtStatus(projectId: number, extId: string, status: "done" | "failed", errorMsg?: string, phaseId?: number | null): Promise<void>;
}

export const defaultTaskLedgerSink: TaskLedgerSink = {
    setExtStatus: (pid, extId, status, errorMsg, phaseId) => updateStatusByExt(pid, extId, status, errorMsg, phaseId),
};

/** developer 终态类型（出站契约三兄弟；Hub content 仍是 JSON 字符串，sender="developer"） */
const DEVELOPER_TERMINAL_TYPES = ["developer_ready", "developer_blocked", "developer_failed"];

/** blocked/failed → 人可读死因：reason/error 原文 + failureSignature 透传（排障据此对齐 repair 轮次） */
function developerFailureReason(data: Record<string, any>): string {
    const base = typeof data.reason === "string" && data.reason
        ? data.reason
        : (typeof data.error === "string" && data.error ? data.error : "developer 未给出原因");
    const sig = typeof data.failureSignature === "string" && data.failureSignature ? data.failureSignature : null;
    const text = sig ? `${base}（failureSignature=${sig}）` : base;
    return text.slice(0, 1000);   // 对齐旧 task_failed 口径：error_msg 列 1000 截断
}

export class Maintainer extends BaseAgent {
    private declaredPairs = new Set<string>();
    private passedPairs = new Set<string>();
    private failedPairs = new Set<string>();
    /** developer 终态记账（新链路）：taskId → "done"|"failed"，兼作幂等 seen 集合（重投/后到矛盾终态只认第一个） */
    private terminalStates = new Map<string, "done" | "failed">();
    /** 失败详情：pairId/taskId → { issues, task, attempts }（3 次兜底上报，阶段完成时汇总） */
    private failedDetails = new Map<string, { issues?: string[]; task?: { id: string; method: string; path: string }; attempts?: number }>();
    private declaredFinal = false;
    private currentPhase = 0;
    private readonly sink: TaskLedgerSink;

    constructor(station: TransferStation, sink: TaskLedgerSink = defaultTaskLedgerSink) {
        super("maintainer", roles.maintainer, station);
        this.sink = sink;
        this.on("task_passed", { fromRoles: [roles.testEngineer] }, async ({ data }) => {
            const key = data.pair?.back?.id;
            // sys_task 桥：接口对通过 → 两端 done（先于流水线判定写，旁路独立于 phase 过滤）
            // ★ await 而非 void：最后一对通过时 done 写若不在 phase_done 发出前落完，会被 runner 退出腰斩（9/3 run10 T4 教训）
            const pid = currentProjectId();
            // ★ phase（阶段 3 修跨阶段串台）：ext 是阶段内编号，done/failed 必须按 (project,phase,ext)
            //   定位——不传会写到"最新阶段同名行"，老行永挂 doing（9/4 live 实锤）。消息链路自带 phase。
            const ph = data.phase as number | undefined;
            if (pid != null && key) {
                await this.sink.setExtStatus(pid, key, "done", undefined, ph);
                if (data.pair?.front?.id) await this.sink.setExtStatus(pid, data.pair.front.id, "done", undefined, ph);
            }
            if (key && data.phase === this.currentPhase) {
                this.passedPairs.add(key);
                console.log(`[maintainer] 收到测试结果：${key} 通过（已收 ${this.passedPairs.size} 对）`);
                this.checkConverged();
            }
        });
        this.on("task_failed", async ({ data, msg, senderRole }) => {
            // sys_task 桥：放弃上报 → 整对 failed（issues 原文进 error_msg，看板卡片可展开）
            // ★ await：同上——最后一对的 failed 必须在 checkConverged 发 phase_done 前落库，否则进程退出丢写
            const pid = currentProjectId();
            if (pid != null && data.pairId) {
                const err = (data.issues ?? []).join("\n").slice(0, 1000) || "返工次数耗尽，该接口对被放弃";
                const ph = data.phase as number | undefined;   // 同上：failed 也按阶段定位
                await this.sink.setExtStatus(pid, data.pairId, "failed", err, ph);
                await this.sink.setExtStatus(pid, `${data.pairId}-F`, "failed", err, ph);   // 无前端配对时 helper 静默跳过
            }
            // 两个来源：合并器（返工轮次耗尽，按名字）和测试（判定 ≥3 次未过，按角色）
            if (data.pairId && data.phase === this.currentPhase
                && (msg.sender === "merger" || senderRole === roles.testEngineer)) {
                this.failedPairs.add(data.pairId);
                if (data.issues || data.task) {
                    this.failedDetails.set(data.pairId, {
                        issues: data.issues ?? [],
                        task: data.task ?? { id: data.pairId, method: "", path: "" },
                        attempts: data.attempts ?? 3,
                    });
                }
                console.log(`[maintainer] 收到 ${msg.sender} 上报：${data.pairId} 放弃${(data.issues?.length ?? 0) > 0 ? `（${data.issues.length} 条原因）` : ""}`);
                this.checkConverged();
            }
        });
        // ---------- 新链路：developer 出站终态三兄弟（9/15） ----------
        this.on(DEVELOPER_TERMINAL_TYPES, { fromNames: ["developer"] }, async ({ data }) => {
            await this.handleDeveloperTerminal(data);
        });
        this.on("tasks_declared", { fromRoles: [roles.architect] }, ({ data }) => {
            this.currentPhase = data.phase ?? this.currentPhase;
            (data.pairIds ?? []).forEach((id: string) => this.declaredPairs.add(id));
            if (data.final) this.declaredFinal = true;
            console.log(`[maintainer] 收到架构师声明：${(data.pairIds ?? []).length} 对${data.final ? "（final）" : ""}`);
            this.checkConverged();
        });
    }

    /**
     * developer 终态 → 逐任务记账 + 收敛检查。
     * 幂等：terminalStates 兼作 seen 集合——同一 taskId 只认第一个终态
     *（重投=噪音；ready 后又来 failed 之类矛盾终态也拒，对齐 task.ts "done 不回退" 的终态保护精神）。
     * ⚠️ phase：developer 冻结契约的终态消息**没有** phase 字段 → 用 tasks_declared 维护的
     *   currentPhase 定位 sys_task 行（架构师先声明后开发，时序天然成立；缺声明则写不中行为静默跳过）。
     */
    private async handleDeveloperTerminal(data: Record<string, any>): Promise<void> {
        const taskId = typeof data.taskId === "string" ? data.taskId : "";
        if (!taskId) { console.warn(`[maintainer] developer 终态缺 taskId，忽略：${data.type ?? "?"}`); return; }
        if (this.terminalStates.has(taskId)) {
            console.log(`[maintainer] ${taskId} 终态重投/后到终态，忽略（已记 ${this.terminalStates.get(taskId)}）`);
            return;
        }
        const isReady = data.type === "developer_ready";
        this.terminalStates.set(taskId, isReady ? "done" : "failed");
        const err = isReady ? undefined : developerFailureReason(data);
        if (!isReady) {
            // 汇入现行失败清单（attempts=1：单开发流终态即定论，返工轮次语义已内化在 developer 内部）
            this.failedDetails.set(taskId, { issues: [err ?? ""], task: { id: taskId, method: "", path: "" }, attempts: 1 });
        }
        // ★ await 同旧链路（9/3 run10 T4 教训）：最后一个终态的写在 phase_done 发出前必须落完
        const pid = currentProjectId();
        if (pid != null) {
            await this.sink.setExtStatus(pid, taskId, isReady ? "done" : "failed", err, this.currentPhase);
        }
        if (isReady) {
            // summary/changedFiles 在 sys_task 无对应可写列（updateStatusByExt 只带 error_msg）→ console 留痕
            console.log(`[maintainer] 收到 developer 终态：${taskId} ready（${data.summary ?? "无摘要"}；改动 ${Array.isArray(data.changedFiles) ? data.changedFiles.length : "?"} 文件）`);
        } else {
            console.log(`[maintainer] 收到 developer 终态：${taskId} ${data.type === "developer_blocked" ? "被阻" : "失败"}——${err}`);
        }
        this.checkConverged();
    }

    private checkConverged(): void {
        if (!this.declaredFinal) return;
        // 兼容收敛（9/15）：id 空间 = 架构师声明集 ∪ developer 终态集，两者都定论才算收敛——
        //   旧形状：declared=pairId，定论来自 task_passed/task_failed；
        //   新形状：declared=workItem/flow id（架构师 lane 可改发），定论来自 terminalStates
        //  （终态天然定论，未声明先到的终态也计入 id 空间，两种形状互不干扰）。
        const concluded = (id: string) =>
            this.passedPairs.has(id) || this.failedPairs.has(id) || this.terminalStates.has(id);
        const universe = [...new Set([...this.declaredPairs, ...this.terminalStates.keys()])];
        if (!universe.every(concluded)) return;
        // 阶段完成：带上失败清单（3 次兜底的接口对 + developer 终态失败），不再静默
        const failed = this.failedPairs.size + [...this.terminalStates.values()].filter(s => s === "failed").length;
        const passed = this.passedPairs.size + [...this.terminalStates.values()].filter(s => s === "done").length;
        const failedList = [...this.failedDetails.entries()].map(([pairId, d]) => ({
            pairId,
            task: d.task ?? { id: pairId, method: "", path: "" },
            issues: d.issues ?? [],
            attempts: d.attempts ?? 3,
        }));
        this.send("architect", { type: "phase_done", phase: this.currentPhase, failed: failedList });
        console.log(`[maintainer] 发送到架构师：阶段 ${this.currentPhase} 完成（${universe.length} 个任务：通过 ${passed}，放弃 ${failed}）`);
        if (failedList.length > 0) {
            failedList.forEach(f => console.log(`   放弃：${f.task.method || ""} ${f.task.path || f.pairId}（${f.attempts} 次）`));
        }
        this.declaredPairs = new Set();
        this.passedPairs = new Set();
        this.failedPairs = new Set();
        this.terminalStates = new Map();
        this.failedDetails = new Map();
        this.declaredFinal = false;
    }
}
