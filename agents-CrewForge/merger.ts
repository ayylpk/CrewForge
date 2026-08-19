// ============================================================
// merger.ts —— 合并器（单例 "merger"，纯程序零 LLM）
//
//   task_result → 按 pairKey 配对 → 都成功 → pair_ready 给测试；失败半边返工
//   phase_reset → 清配对/交付缓存；task_failed → 放弃该对
//
// 配对 key 约定：后端 id 原样（T1）、前端剥 "-F"（T1-F → T1）
// ============================================================

import { BaseAgent } from "./BaseAgent";
import { roles, type TransferStation } from "./Hub";
import type { ExecTask } from "./common";

interface PendingPair {
    back?: ExecTask;
    front?: ExecTask;
    backOk?: boolean;
    frontOk?: boolean;
    reworkCount: number;
}

export class Merger extends BaseAgent {
    private readonly pending = new Map<string, PendingPair>();
    private readonly delivered = new Map<string, PendingPair>();
    private readonly abandoned = new Set<string>();
    private currentPhase = 0;

    constructor(station: TransferStation) {
        super("merger", roles.unknown, station);
        this.on("phase_reset", ({ data }) => {
            this.pending.clear();
            this.delivered.clear();
            this.abandoned.clear();
            this.currentPhase = data.phase ?? 0;
            console.log(`[merger] 阶段 ${data.phase} 开始：配对缓存已重置`);
        });
        this.on("task_failed", ({ data }) => {
            if (data.pairId) { this.abandoned.add(data.pairId); this.pending.delete(data.pairId); }
        });
        this.on("task_result", ({ data }) => this.pair(data.task as ExecTask, data.success as boolean));
    }

    private pair(task: ExecTask, success: boolean): void {
        const pairKey = task.id.endsWith("-F") ? task.id.slice(0, -2) : task.id;
        if (this.abandoned.has(pairKey)) return;   // 已放弃的对：忽略迟到结果

        const slot = this.pending.get(pairKey) ?? { reworkCount: 0 };
        if (task.layer === "backend") { slot.back = task; slot.backOk = success; }
        else { slot.front = task; slot.frontOk = success; }
        // 对侧缺失 → 从交付缓存补位（对侧没被判错就没在重做）
        const cached = this.delivered.get(pairKey);
        if (!slot.back && cached?.back) { slot.back = cached.back; slot.backOk = cached.backOk; }
        if (!slot.front && cached?.front) { slot.front = cached.front; slot.frontOk = cached.frontOk; }
        this.pending.set(pairKey, slot);

        // 返工轮次：任一失败 +1；≥3 放弃上报维护
        if (slot.backOk === false || slot.frontOk === false) slot.reworkCount += 1;
        if (slot.reworkCount >= 3) {
            this.send("maintainer", { type: "task_failed", phase: this.currentPhase, pairId: pairKey });
            this.abandoned.add(pairKey);
            this.pending.delete(pairKey);
            console.log(`[merger] ${pairKey} 返工 ${slot.reworkCount} 轮仍失败，放弃并上报维护`);
            return;
        }

        // 失败的半边 → 发回对应开发返工
        if (slot.backOk === false && slot.back) {
            const target = this.station.pickLeastBusy(roles.backendEngineer);
            if (target) { this.send(target, { type: "task", task: slot.back }); slot.backOk = undefined; }
        }
        if (slot.frontOk === false && slot.front) {
            const target = this.station.pickLeastBusy(roles.frontendEngineer);
            if (target) { this.send(target, { type: "task", task: slot.front }); slot.frontOk = undefined; }
        }

        // 配齐且都成功 → 发给测试，交付留档
        if (slot.back && slot.front && slot.backOk === true && slot.frontOk === true) {
            const test = this.station.pickLeastBusy(roles.testEngineer);
            if (!test) { console.log(`提示：没有测试注册，${pairKey} 滞留等待`); return; }
            this.send(test, { type: "pair_ready", phase: this.currentPhase, pair: { back: slot.back, front: slot.front } });
            console.log(`[merger] 发送到 ${test}：${pairKey} 配对完成`);
            this.delivered.set(pairKey, { back: slot.back, front: slot.front, backOk: true, frontOk: true, reworkCount: 0 });
            this.pending.delete(pairKey);
        }
    }
}
