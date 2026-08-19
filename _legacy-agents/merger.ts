// ============================================================
// 合并器（merger）：配对装配环节——纯程序，零 LLM
//
//   前后端干完的 task_result 都发到这里，按 pairId 缓存配对；
//   一个接口对（后端 + 前端）都到达且都成功 → 统一发往测试 agent。
//   失败的半边发回对应开发返工（task 消息），pair 继续等。
//
// 职责链：拆分（架构师）→ 装配（合并器）→ 判断（测试）
// 这是纯代码环节：没有模型调用、没有图，就是收发 + Map 缓存 + 条件判断
//
// 消息协议（content 为 JSON 字符串）：
//   开发 → 合并器: {"type": "task_result", "task": ExecTask, "success": bool}
//   合并器 → 测试: {"type": "pair_ready", "pair": {"back": ExecTask, "front": ExecTask}}
//   合并器 → 开发: {"type": "task", "task": ExecTask}   （失败返工，和架构师下发同协议）
//
// 配对 key 约定（不用额外传 pairId）：
//   后端 id 原样（T1）、前端 id 剥 "-F" 后缀（T1-F → T1）——两者汇到同一个 key
// ============================================================

import { TransferStation, roles } from "./Hub.ts";

// 任务（与各 agent 文件一致的 ExecTask，合并器只用 id/layer 字段）
interface ExecTask {
  id: string;
  layer: "backend" | "frontend";
  method: string;
  path: string;
  files: string[];
  title: string;
  description: string;
  parameters: { name: string; type: string; required: boolean; description: string }[];
  acceptance: string;
}

// 等待中的接口对：pairId → 后端/前端任务各占一位（+ 各自成败标记）
interface PendingPair {
  back?: ExecTask;
  front?: ExecTask;
  backOk?: boolean;
  frontOk?: boolean;
  reworkCount: number;   // 已返工轮数：≥3 放弃（防 LLM 持续失败无限返工）
}

// 配对缓存：pairId → 半成品对（后端先到、前端后到，谁先到都行）
const pending = new Map<string, PendingPair>();

// 交付缓存：pairId → 最近一次成功交付的完整对
// 用途：测试 revision 返工后，半边交回时对侧缺失（对侧没被判错、没在重做）→ 用缓存补位配对
const deliveredCache = new Map<string, PendingPair>();

// 合并器入口（函数化：唯一装配点，单例，名字写死 "merger"；由 start.ts 拉起）
export async function runMerger(station: TransferStation) {
    let currentPhase = 0;
    // 已放弃的对：测试/合并器判定放弃后，迟到的返工结果不再重新配对，
    // 否则同一对会反复发给测试（测试的判定计数跨阶段残留，还会污染维护的记账）。
    const abandoned = new Set<string>();

    async function messageLoop() {
        console.log("[merger] 已启动：等前后端 task_result 配对");
        while (true) {
            const msg = await station.waitForMessage("merger");
            if (!msg) { station.markDone("merger"); continue; }
            let data: { type?: string; task?: ExecTask; success?: boolean; phase?: number; pairId?: string };
            try { data = JSON.parse(msg.content); } catch { station.markDone("merger"); continue; }

            // 新阶段开始：清空配对/交付缓存（任务 id 每阶段从 T1 重新编号，防跨阶段撞 key）
            if (data.type === "phase_reset") {
                pending.clear();
                deliveredCache.clear();
                abandoned.clear();
                currentPhase = data.phase ?? currentPhase;
                console.log(`[merger] 阶段 ${data.phase} 开始：配对/交付缓存已重置`);
                station.markDone("merger");
                continue;
            }

            // 测试判定放弃（≥3 次未过）→ 本合并器停止为该对继续配对（迟到结果直接忽略）
            if (data.type === "task_failed" && data.pairId) {
                abandoned.add(data.pairId);
                pending.delete(data.pairId);
                console.log(`[merger] 收到测试上报：${data.pairId} 已放弃，后续结果不再配对`);
                station.markDone("merger");
                continue;
            }

            if (data.type !== "task_result" || !data.task) { station.markDone("merger"); continue; }

            // 配对 key：前端剥 "-F"（T1-F → T1），后端原样（T1 → T1）——谁先到都进同一个槽位
            const pairKey = data.task.id.endsWith("-F") ? data.task.id.slice(0, -2) : data.task.id;

            // 已放弃的对：忽略迟到结果（防测试放弃后返工结果又把它复活）
            if (abandoned.has(pairKey)) {
                console.log(`[merger] 忽略已放弃的对 ${pairKey} 的迟到结果（${data.task.id}）`);
                station.markDone("merger");
                continue;
            }

            // 放进等待中的对（后端/前端各占一位；先到的占位，后到的补位）
            // 不存在则直接建 key（测试 revision 返工后半边交回：slot 已删，这里重建）
            const slot = pending.get(pairKey) ?? { reworkCount: 0 };
            if (data.task.layer === "backend") { slot.back = data.task; slot.backOk = data.success; }
            else { slot.front = data.task; slot.frontOk = data.success; }
            // 对侧缺失 → 从交付缓存补位（对侧没被判错就没在重做，旧交付即最终版）
            const cached = deliveredCache.get(pairKey);
            if (!slot.back && cached?.back) { slot.back = cached.back; slot.backOk = cached.backOk; }
            if (!slot.front && cached?.front) { slot.front = cached.front; slot.frontOk = cached.frontOk; }
            pending.set(pairKey, slot);

            const mark = (v?: boolean) => v === undefined ? "待定" : v ? "通过" : "失败";
            console.log(`[merger] 收到 ${msg.sender} 的结果：${data.task.id} ${data.success ? "成功" : "失败"}，${pairKey} 状态：后端${mark(slot.backOk)}，前端${mark(slot.frontOk)}`);

            // 返工轮次：本次配对任一失败 → reworkCount +1（防 LLM 持续失败无限返工）
            if (slot.backOk === false || slot.frontOk === false) slot.reworkCount += 1;

            if (slot.reworkCount >= 3) {
                // 放弃该对：通知维护记失败（保证阶段能收敛，不会卡死），清理配对缓存
                station.sendMessage("merger", "maintainer", JSON.stringify({ type: "task_failed", phase: currentPhase, pairId: pairKey }));
                abandoned.add(pairKey);
                console.log(`[merger] 提示：${pairKey} 返工 ${slot.reworkCount} 轮仍失败，放弃并上报维护`);
                pending.delete(pairKey);
            } else {
                // 失败的半边 → 发回对应开发返工（和架构师下发同协议 task），清掉成败标记等返工结果
                // 目标用 pickLeastBusy 按角色选（多开发场景不写死名字：backend1/backend2 谁闲选谁）
                if (slot.backOk === false && slot.back) {
                    const target = station.pickLeastBusy(roles.backendEngineer);
                    if (target) {
                        station.sendMessage("merger", target, JSON.stringify({ type: "task", task: slot.back }));
                        slot.backOk = undefined;   // 等返工结果重新填
                        console.log(`[merger] 发送到 ${target}：${slot.back.id} 返工`);
                    } else {
                        console.log(`提示：没有后端开发注册，${slot.back.id} 返工发送失败，滞留等待`);
                    }
                }
                if (slot.frontOk === false && slot.front) {
                    const target = station.pickLeastBusy(roles.frontendEngineer);
                    if (target) {
                        station.sendMessage("merger", target, JSON.stringify({ type: "task", task: slot.front }));
                        slot.frontOk = undefined;   // 等返工结果重新填
                        console.log(`[merger] 发送到 ${target}：${slot.front.id} 返工`);
                    } else {
                        console.log(`提示：没有前端开发注册，${slot.front.id} 返工发送失败，滞留等待`);
                    }
                }
            }

            // 配齐且都成功 → 发给测试（按对负载均衡：一对一个测试）
            if (slot.back && slot.front && slot.backOk === true && slot.frontOk === true) {
                const test = station.pickLeastBusy(roles.testEngineer);
                if (!test) { console.log(`提示：没有测试注册，${pairKey} 滞留等待`); station.markDone("merger"); continue; }
                station.sendMessage("merger", test, JSON.stringify({ type: "pair_ready", phase: currentPhase, pair: { back: slot.back, front: slot.front } }));
                console.log(`[merger] 发送到 ${test}：${pairKey} 配对完成（后端 ${slot.back.id} + 前端 ${slot.front.id}）`);
                // 交付完成：留档交付缓存（返工半边交回时补位用），pending 回收
                deliveredCache.set(pairKey, { back: slot.back, front: slot.front, backOk: true, frontOk: true, reworkCount: 0 });
                pending.delete(pairKey);
            }
            station.markDone("merger");   // 处理完记账（负载均衡的数据基础：pendingCount -1）
        }
    }

    // 挂住等消息（进程保持存活）
    await messageLoop();
}
