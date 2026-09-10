// ============================================================
// merger.ts —— 合并器（单例 "merger"，纯程序零 LLM）
//
//   task_result → 按 pairKey 配对 → 都成功 → 【p3 修⑤集成预检】绿了才 pair_ready 给测试；
//   预检红=定向打回开发（不计测试判定名额，=7 条清单之 #6 的落地形态）；失败半边返工
//   phase_reset → 清配对/交付缓存；task_failed → 放弃该对
//
// 配对 key 约定：后端 id 原样（T1）、前端剥 "-F"（T1-F → T1）
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { BaseAgent } from "./BaseAgent";
import { roles, type TransferStation } from "./Hub";
import type { ExecTask } from "./common";
import { currentProjectId, projectDir } from "./runEnv";
import { pairIntegrationCheck } from "./foundation";

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
        super("merger", roles.merger, station);
        this.on("phase_reset", ({ data }) => {
            if (data.pairId) {
                // 单对重置：测试 3 次回炉架构师重设计后，清该对的配对/交付/放弃状态（防旧版缓存串新任务）
                this.pending.delete(data.pairId);
                this.delivered.delete(data.pairId);
                this.abandoned.delete(data.pairId);
                console.log(`[merger] 重设计重置：${data.pairId}`);
            } else {
                this.pending.clear();
                this.delivered.clear();
                this.abandoned.clear();
                this.currentPhase = data.phase ?? 0;
                console.log(`[merger] 阶段 ${data.phase} 开始：配对缓存已重置`);
            }
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

        // 返工轮次：任一失败 +1；≥3 放弃上报维护（带原因，不静默）
        if (slot.backOk === false || slot.frontOk === false) slot.reworkCount += 1;
        if (slot.reworkCount >= 3) {
            const issues = [`开发自测失败 ${slot.reworkCount} 轮（merger 层放弃，未进入测试判定）`];
            this.send("maintainer", {
                type: "task_failed", phase: this.currentPhase, pairId: pairKey,
                issues, task: { id: pairKey, method: slot.back?.method ?? "", path: slot.back?.path ?? "" },
                attempts: slot.reworkCount,
            });
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

        // 配齐且都成功 → 先过集成预检（p3 修⑤，9/9）：纯字面量比对 api 调用 vs 后端路由 vs 任务契约，
        // 红=定向打回对应工位重做（附死因），不烧测试判定名额——p2 时代"编译都没过就送判"的对称面是
        // "接口都没对上就送判"，预检把这层挪到代码。预检本身出错（读盘炸等）=放行送判（旁路家法）
        if (slot.back && slot.front && slot.backOk === true && slot.frontOk === true) {
            const test = this.station.pickLeastBusy(roles.testEngineer);
            if (!test) { console.log(`提示：没有测试注册，${pairKey} 滞留等待`); return; }
            let problems: string[] = [];
            try {
                problems = pairIntegrationCheck(slot.back, slot.front, this.readCodes(slot.back.files), this.readCodes(slot.front.files));
            } catch (e) { console.warn(`[merger] ${pairKey} 集成预检异常（旁路放行送判）:`, (e as Error).message); }
            if (problems.length > 0) {
                const backIssues = problems.filter(p => p.includes("后端"));
                const frontIssues = problems.filter(p => !p.includes("后端"));
                slot.reworkCount += 1;
                console.log(`[merger] ${pairKey} 集成预检红 ${problems.length} 条（不计判定名额）：${problems.join("；").slice(0, 160)}`);
                if (backIssues.length > 0 && slot.back) {
                    const target = this.station.pickLeastBusy(roles.backendEngineer);
                    if (target) {
                        this.send(target, { type: "task", task: { ...slot.back, description: slot.back.description + "\n\n【集成预检打回（引擎字面比对，必须逐条解决）】\n" + backIssues.join("\n") } });
                        slot.backOk = undefined;
                    }
                }
                if (frontIssues.length > 0 && slot.front) {
                    const target = this.station.pickLeastBusy(roles.frontendEngineer);
                    if (target) {
                        this.send(target, { type: "task", task: { ...slot.front, description: slot.front.description + "\n\n【集成预检打回（引擎字面比对，必须逐条解决）】\n" + frontIssues.join("\n") } });
                        slot.frontOk = undefined;
                    }
                }
                this.pending.set(pairKey, slot);
                if (!backIssues.length && !frontIssues.length) { this.pending.delete(pairKey); }   // 全归不了责：放行送判，不空转
                else return;
            }
            this.send(test, { type: "pair_ready", phase: this.currentPhase, pair: { back: slot.back, front: slot.front } });
            console.log(`[merger] 发送到 ${test}：${pairKey} 配对完成（集成预检通过）`);
            this.delivered.set(pairKey, { back: slot.back, front: slot.front, backOk: true, frontOk: true, reworkCount: 0 });
            this.pending.delete(pairKey);
        }
    }

    /** 预检读盘：直读 runs/pN（writeWorkspace 先盘后库，DB 有异步延迟；盘永远最新）；读不到=空串（少报=放行侧） */
    private readCodes(files: string[]): string[] {
        const pid = currentProjectId();
        if (pid == null) return [];
        return files.map(f => {
            try {
                const full = path.join(projectDir(pid), f);
                return fs.existsSync(full) ? fs.readFileSync(full, "utf-8") : "";
            } catch { return ""; }
        });
    }
}
