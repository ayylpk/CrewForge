// ============================================================
// start.ts：项目启动器（一项目一进程）
//   用法：bun run start.ts <projectId>（缺省 "demo"）
//   一个进程 = 一个项目 = 一个站 = 一个 agent 团队（进程内全局共享站）
//
//   多项目：每条命令一个进程，进程间零通信、纯隔离
//   平台后端（Java）用 ProcessBuilder spawn 本脚本管理项目生命周期
// ============================================================

import fs from "node:fs";
import { TransferStation, roles } from "./Hub.ts";   // 站 + 角色枚举
import { runManager } from "./manager.ts";
import { runArchitect } from "./architect.ts";
import { runBackend } from "./backendEngineer.ts";
import { runFrontend } from "./frontendEngineer.ts";
import { runMerger } from "./merger.ts";
import { runTest } from "./testEngineer.ts";
import { runMaintainer } from "./maintainer.ts";

// ---------- 项目身份 ----------

const projectId = process.argv[2] ?? "demo";   // 启动时传项目 id

// ⚠️ 每项目一个工作目录：plan.json / tasks.json / workspace/ 都落在自己目录里，
// 多进程同时跑不互相覆盖（文件交接物按项目隔离）
fs.mkdirSync(`projects/${projectId}`, { recursive: true });
process.chdir(`projects/${projectId}`);

// ---------- 中转站声明（进程内全局唯一） ----------

// 本项目唯一的站：所有 agent 通过传入/导入拿到同一个实例，消息互通
const station = new TransferStation({}, {});

// 角色注册：谁是谁，一个地方看清楚
// 多开发/多测试：同角色注册多个名字（backend1/backend2…），pickLeastBusy 负载均衡
station.register("manager", roles.manager);
station.register("architect", roles.architect);
station.register("backend1", roles.backendEngineer);
station.register("frontend1", roles.frontendEngineer);
station.register("merger", roles.unknown);  // 合并器：唯一装配点，非角色成员（roles 枚举无 merger），按名字寻址，不被负载均衡选择
station.register("testEngineer", roles.testEngineer);
station.register("maintainer", roles.maintainer);

// ---------- 拉起团队（并发运行，全项目共享同一个站） ----------

console.log(`[${projectId}] 中转站就绪：${Object.keys(station.status).length} 个 agent 已注册，团队拉起……`);

// 全部 agent 并发跑（各自挂在各自的 wait 上；LLM 等待期间事件循环交替执行）
// 多开发/多测试：同角色注册多个名字后，这里多传几个 runBackend("backend2", station)
await Promise.all([
    runManager(station),
    runArchitect(station),
    runBackend("backend1", station),
    runFrontend("frontend1", station),
    runMerger(station),
    runTest("testEngineer", station),
    runMaintainer(station),
]);

console.log(`[${projectId}] 团队全部退出（异常收尾）。`);
