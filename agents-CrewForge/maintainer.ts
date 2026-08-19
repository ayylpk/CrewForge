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

export class Maintainer extends BaseAgent {
    private declaredPairs = new Set<string>();
    private passedPairs = new Set<string>();
    private failedPairs = new Set<string>();
    private declaredFinal = false;
    private currentPhase = 0;

    constructor(station: TransferStation) {
        super("maintainer", roles.maintainer, station);
        this.on("task_passed", { fromRoles: [roles.testEngineer] }, ({ data }) => {
            const key = data.pair?.back?.id;
            if (key && data.phase === this.currentPhase) {
                this.passedPairs.add(key);
                console.log(`[maintainer] 收到测试结果：${key} 通过（已收 ${this.passedPairs.size} 对）`);
                this.checkConverged();
            }
        });
        this.on("task_failed", ({ data, msg, senderRole }) => {
            // 两个来源：合并器（返工轮次耗尽，按名字）和测试（判定 ≥3 次未过，按角色）
            if (data.pairId && data.phase === this.currentPhase
                && (msg.sender === "merger" || senderRole === roles.testEngineer)) {
                this.failedPairs.add(data.pairId);
                console.log(`[maintainer] 收到 ${msg.sender} 上报：${data.pairId} 放弃`);
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
        // 阶段完成
        const failed = this.failedPairs.size;
        this.send("architect", { type: "phase_done", phase: this.currentPhase });
        console.log(`[maintainer] 发送到架构师：阶段 ${this.currentPhase} 完成（${this.declaredPairs.size} 对：通过 ${this.declaredPairs.size - failed}，放弃 ${failed}）`);
        this.declaredPairs = new Set();
        this.passedPairs = new Set();
        this.failedPairs = new Set();
        this.declaredFinal = false;
    }
}
