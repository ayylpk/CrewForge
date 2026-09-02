// ============================================================
// maintainer.ts —— 维护（单例 "maintainer"，纯程序零 LLM）
//
//   集合收敛：架构师声明(final) + 每对都有定论(通过/放弃) → 阶段完成
//   → phase_done 给架构师（架构师转告 PM 请求下一阶段）
//
// 完成标准不预定义 N：声明可动态追加，final=true 表示本阶段不再有任务
// ============================================================

import { BaseAgent } from "./BaseAgent";
import { roles, type TransferStation } from "./Hub";
import { currentProjectId } from "./runEnv";
import { updateStatusByExt } from "./task";

export class Maintainer extends BaseAgent {
    private declaredPairs = new Set<string>();
    private passedPairs = new Set<string>();
    private failedPairs = new Set<string>();
    /** 失败详情：pairId → { issues, task, attempts }（3 次兜底上报，阶段完成时汇总） */
    private failedDetails = new Map<string, { issues?: string[]; task?: { id: string; method: string; path: string }; attempts?: number }>();
    private declaredFinal = false;
    private currentPhase = 0;

    constructor(station: TransferStation) {
        super("maintainer", roles.maintainer, station);
        this.on("task_passed", { fromRoles: [roles.testEngineer] }, ({ data }) => {
            const key = data.pair?.back?.id;
            // sys_task 桥：接口对通过 → 两端 done（先于流水线判定写，旁路独立于 phase 过滤）
            const pid = currentProjectId();
            if (pid != null && key) {
                void updateStatusByExt(pid, key, "done");
                if (data.pair?.front?.id) void updateStatusByExt(pid, data.pair.front.id, "done");
            }
            if (key && data.phase === this.currentPhase) {
                this.passedPairs.add(key);
                console.log(`[maintainer] 收到测试结果：${key} 通过（已收 ${this.passedPairs.size} 对）`);
                this.checkConverged();
            }
        });
        this.on("task_failed", ({ data, msg, senderRole }) => {
            // sys_task 桥：放弃上报 → 整对 failed（issues 原文进 error_msg，看板卡片可展开）
            const pid = currentProjectId();
            if (pid != null && data.pairId) {
                const err = (data.issues ?? []).join("\n").slice(0, 1000) || "返工次数耗尽，该接口对被放弃";
                void updateStatusByExt(pid, data.pairId, "failed", err);
                void updateStatusByExt(pid, `${data.pairId}-F`, "failed", err);   // 无前端配对时 helper 静默跳过
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
        this.on("tasks_declared", { fromRoles: [roles.architect] }, ({ data }) => {
            this.currentPhase = data.phase ?? this.currentPhase;
            (data.pairIds ?? []).forEach((id: string) => this.declaredPairs.add(id));
            if (data.final) this.declaredFinal = true;
            console.log(`[maintainer] 收到架构师声明：${(data.pairIds ?? []).length} 对${data.final ? "（final）" : ""}`);
            this.checkConverged();
        });
    }

    private checkConverged(): void {
        if (!this.declaredFinal) return;
        if (this.declaredPairs.size > 0 &&
            ![...this.declaredPairs].every(p => this.passedPairs.has(p) || this.failedPairs.has(p))) return;
        // 阶段完成：带上失败清单（3 次兜底的接口对 + 原因），不再静默
        const failed = this.failedPairs.size;
        const failedList = [...this.failedDetails.entries()].map(([pairId, d]) => ({
            pairId,
            task: d.task ?? { id: pairId, method: "", path: "" },
            issues: d.issues ?? [],
            attempts: d.attempts ?? 3,
        }));
        this.send("architect", { type: "phase_done", phase: this.currentPhase, failed: failedList });
        console.log(`[maintainer] 发送到架构师：阶段 ${this.currentPhase} 完成（${this.declaredPairs.size} 对：通过 ${this.declaredPairs.size - failed}，放弃 ${failed}）`);
        if (failedList.length > 0) {
            failedList.forEach(f => console.log(`   放弃：${f.task.method || ""} ${f.task.path || f.pairId}（${f.attempts} 次）`));
        }
        this.declaredPairs = new Set();
        this.passedPairs = new Set();
        this.failedPairs = new Set();
        this.failedDetails = new Map();
        this.declaredFinal = false;
    }
}
