// ============================================================
// 维护工程师（v2）：阶段门控——纯程序，零 LLM
//
//   收测试的 task_passed（通过的接口对）+ 架构师的 tasks_declared（任务声明）
//   → 集合收敛判断：架构师声明 final=true 且所有已声明对都通过 → 阶段完成
//   → 发 phase_done 给架构师（架构师转告 PM 请求下一阶段）
//
// 设计：完成标准不预定义 N，由"声明 + 收敛"决定——
//   架构师边发任务边声明（可动态追加/分批），维护按对 id 去重累积，
//   final=true 表示本阶段不再有任务。阶段完成 = 声明耗尽 + 全部通过。
//
// 消息协议（content 为 JSON 字符串）：
//   测试 → 维护:     {"type": "task_passed", "pair": {"back": ExecTask, "front": ExecTask|null}}
//   架构师 → 维护:   {"type": "tasks_declared", "phase": N, "pairIds": ["T1", ...], "final": bool}
//   维护 → 架构师:   {"type": "phase_done", "phase": N}   （阶段完成信号）
// ============================================================

import { TransferStation, roles } from "./Hub.ts";

// 任务（与各 agent 文件一致的 ExecTask）
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

// 接口对（测试发来的 task_passed 携带）
interface Pair {
  back: ExecTask;
  front: ExecTask | null;
}

// 维护入口（函数化：阶段门控，单例，名字写死 "maintainer"；由 start.ts 拉起）
export async function runMaintainer(station: TransferStation) {
    // 本阶段状态（每阶段完成时重置）：
    let declaredPairs = new Set<string>();   // 架构师声明的对（pairId，可动态追加）
    let passedPairs = new Set<string>();     // 已通过的对（pairId，按对去重）
    let declaredFinal = false;               // 架构师声明"本阶段拆完了，不再有任务"
    let currentPhase = 0;                    // 当前阶段号

    async function messageLoop() {
        console.log("[maintainer] 已启动：等测试报通过 / 架构师声明任务");
        while (true) {
            const msg = await station.waitForMessage("maintainer");
            if (!msg) continue;
            let data: { type?: string; phase?: number; pairIds?: string[]; final?: boolean; pair?: Pair };
            try { data = JSON.parse(msg.content); } catch { continue; }

            // 用角色检测发送方（多实例场景名字不定，role 才是身份）
            const senderRole = station.status[msg.sender]?.role;
            let handled = false;

            if (senderRole === roles.testEngineer && data.type === "task_passed" && data.pair?.back?.id) {
                // 测试判过的一对 → 按对 id 去重累积（返工不影响：同一对只 pass 一次）
                const key = data.pair.back.id;
                passedPairs.add(key);
                console.log(`[maintainer] ← 测试：${key} 通过（已收 ${passedPairs.size} 对）`);
                handled = true;
            } else if (senderRole === roles.architect && data.type === "tasks_declared") {
                // 架构师声明任务（可多次追加；final=true 表示本阶段不再有）
                currentPhase = data.phase ?? currentPhase;
                (data.pairIds ?? []).forEach(id => declaredPairs.add(id));
                if (data.final) declaredFinal = true;
                console.log(`[maintainer] ← 架构师：声明 ${(data.pairIds ?? []).length} 对${data.final ? "（final：本阶段不再有）" : ""}，累计 ${declaredPairs.size} 对`);
                handled = true;
            }

            // 集合收敛判断：架构师说拆完了 && 所有已声明对都通过 → 阶段完成
            if (handled && declaredFinal && declaredPairs.size > 0 && [...declaredPairs].every(p => passedPairs.has(p))) {
                station.sendMessage("maintainer", "architect", JSON.stringify({ type: "phase_done", phase: currentPhase }));
                console.log(`[maintainer] → 架构师：阶段 ${currentPhase} 全部完成（${declaredPairs.size} 对全通过），请转告 PM 下一阶段`);
                // 重置，等下一阶段（新声明 + 新通过）
                declaredPairs = new Set();
                passedPairs = new Set();
                declaredFinal = false;
            }
            station.markDone("maintainer");   // 处理完记账（负载均衡的数据基础）
        }
    }

    // 挂住等消息（进程保持存活）
    await messageLoop();
}
