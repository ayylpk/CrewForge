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
}

// 配对缓存：pairId → 半成品对（后端先到、前端后到，谁先到都行）
const pending = new Map<string, PendingPair>();

// 合并器入口（函数化：唯一装配点，单例，名字写死 "merger"；由 start.ts 拉起）
export async function runMerger(station: TransferStation) {
    async function messageLoop() {
        console.log("[merger] 已启动：等前后端 task_result 配对");
        while (true) {
            const msg = await station.waitForMessage("merger");
            if (!msg) continue;
            let data: { type?: string; task?: ExecTask; success?: boolean };
            try { data = JSON.parse(msg.content); } catch { continue; }
            if (data.type !== "task_result" || !data.task) continue;

            // 配对 key：前端剥 "-F"（T1-F → T1），后端原样（T1 → T1）——谁先到都进同一个槽位
            const pairKey = data.task.id.endsWith("-F") ? data.task.id.slice(0, -2) : data.task.id;

            // 放进等待中的对（后端/前端各占一位；先到的占位，后到的补位）
            const slot = pending.get(pairKey) ?? {};
            if (data.task.layer === "backend") { slot.back = data.task; slot.backOk = data.success; }
            else { slot.front = data.task; slot.frontOk = data.success; }
            pending.set(pairKey, slot);

            const mark = (v?: boolean) => v === undefined ? "…" : v ? "✓" : "✗";
            console.log(`[merger] ← ${msg.sender}：${data.task.id} ${data.success ? "成功" : "失败"}，${pairKey} 状态：后端${mark(slot.backOk)} 前端${mark(slot.frontOk)}`);

            // 失败的半边 → 发回对应开发返工（和架构师下发同协议 task），清掉成败标记等返工结果
            if (slot.backOk === false && slot.back) {
                station.sendMessage("merger", "backend", JSON.stringify({ type: "task", task: slot.back }));
                slot.backOk = undefined;
                console.log(`[merger] → backend：${slot.back.id} 返工`);
            }
            if (slot.frontOk === false && slot.front) {
                station.sendMessage("merger", "frontend", JSON.stringify({ type: "task", task: slot.front }));
                slot.frontOk = undefined;
                console.log(`[merger] → frontend：${slot.front.id} 返工`);
            }

            // 配齐且都成功 → 发给测试（按对负载均衡：一对一个测试）
            if (slot.back && slot.front && slot.backOk === true && slot.frontOk === true) {
                const test = station.pickLeastBusy(roles.testEngineer);
                if (!test) { console.log(`⚠️ 没有测试注册，${pairKey} 滞留等待`); continue; }
                station.sendMessage("merger", test, JSON.stringify({ type: "pair_ready", pair: { back: slot.back, front: slot.front } }));
                console.log(`[merger] → ${test}：${pairKey} 配对完成（后端 ${slot.back.id} + 前端 ${slot.front.id}）`);
                pending.delete(pairKey);   // 交付完成，回收
            }
        }
    }

    // 挂住等消息（进程保持存活）
    await messageLoop();
}
