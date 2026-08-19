// ============================================================
// index.ts —— 入口演示：两种 Agent 形态
//
//   图版（GraphFactory 驱动，无消息循环）：
//     Manager —— new Manager() 即拼图；run(input, thread, questioner) 对话
//
//   消息版（BaseAgent 驱动，消息循环 + 队列流水线）：
//     Architect / Merger / Maintainer（单例）
//     BackendEngineer / FrontendEngineer / TestEngineer（多实例，构造传名字）
//
//   团队消息协议（对齐 _legacy-agents）：
//     manager → architect: phase_plan
//     architect → backend/frontend: task        merger → 开发: task（返工）
//     开发 → merger: task_result
//     merger → test: pair_ready
//     test → 开发: revision                      test → maintainer: task_passed
//     merger/test → maintainer: task_failed
//     architect → maintainer: tasks_declared     maintainer → architect: phase_done
//     architect → manager: phase_request
// ============================================================

import { TransferStation } from "./Hub";
import { BaseAgent } from "./BaseAgent";
import { Manager } from "./manager";                    // 图版（无 station 参数）
import { Architect } from "./architect";
import { BackendEngineer } from "./backendEngineer";
import { FrontendEngineer } from "./frontendEngineer";
import { Merger } from "./merger";
import { TestEngineer } from "./testEngineer";
import { Maintainer } from "./maintainer";

/** 消息版团队（不含 Manager——Manager 是图版，单独跑对话） */
export function createTeam(): { station: TransferStation; team: BaseAgent[] } {
    const station = new TransferStation({}, {});
    const team: BaseAgent[] = [
        new Architect(station),
        new BackendEngineer("backend1", station),
        new FrontendEngineer("frontend1", station),
        new Merger(station),
        new TestEngineer("test1", station),
        new Maintainer(station),
    ];
    return { station, team };
}

/** 启动消息版团队（并发常驻，各自挂在消息循环上） */
export async function startTeam(team: BaseAgent[]): Promise<void> {
    await Promise.all(team.map(a => a.start()));
}

// ---------- 演示 ----------

if (import.meta.main) {
    // 图版 Manager：new 即拼图（无 DEEPSEEK_API_KEY 也能 build，调用时才报错）
    const manager = new Manager();
    console.log("图版 Manager 已构建：pm → dispose → planner（可 run() 对话）");

    // 消息版团队
    const { station, team } = createTeam();
    console.log(`消息版团队已构建：${Object.keys(station.status).join("、")}`);
    console.log("\n用法：");
    console.log("  图版：   const result = await manager.run({ messages: [HumanMessage] }, 'thread-1', new CliQuestioner());");
    console.log("  消息版： await startTeam(team)  （等消息，Ctrl+C 退出）");
    console.log("  生产：   const m = await Manager.fromDb(agentId);   // DB 声明驱动");
}
