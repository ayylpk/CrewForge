// ============================================================
// run-demo.ts —— 新版编排演示入口（替代被删的旧 start.ts）
//
//   职责：把"图版 Manager（对话产出 plan）"接上"消息版团队（架构师拆→开发→测试→维护）"
//   图版 Manager 不在消息站里，所以本脚本当发件人：
//     ① Manager.run(需求) → plan
//     ② 往 plan 注入 techStack（数据通道，不改提示词；GraphFactory 会把整个 state 灌给
//        架构师每个 LLM 节点，技术栈约束自然传导）
//     ③ 逐阶段把 phase_plan 塞进架构师收件箱 → 团队流水线自己转
//     ④ 架构师每完成一阶段回 phase_request 到 "manager"（惰性 hub），脚本收到即为阶段完成信号
//     ⑤ 所有阶段发完并收完 → 打印汇总退出
//
//   用法（两行 stdin：需求 + PM 确认结束语；AUTO_CONFIRM=1 跳过架构师确认门）：
//     printf '%s\n' "需求" "就这些，确认完成" | AUTO_CONFIRM=1 bun run run-demo.ts
// ============================================================

import { createTeam } from "./index.ts";
import { Manager } from "./manager.ts";
import { CliQuestioner, type Questioner } from "./GraphFactory.ts";
import { HumanMessage } from "@langchain/core/messages";

// 模拟沙箱项目号：writeWorkspace 依赖 PROJECT_ID 决定写盘目录（runs/p{id}/）。
// 不设则所有写盘抛"缺少 PROJECT_ID"崩溃工位（demo 场景固定用 1；真实运行由 Java 侧设置）
process.env.PROJECT_ID ??= "1";
const DEMO_PROJECT_ID = 1;

const TECH_STACK =
  "后端 FastAPI + SQLAlchemy + aiomysql（MySQL 数据库，禁止 SQLite）；" +
  "前端 Vue 3 + Element Plus + Axios。后端端口 8000，前端端口 5173。";

// 需求：第一行（argv 优先，缺省给默认需求）；末尾必须显式声明定稿——
// PM 规则"首轮不确认功能"，不声明定稿 PM 会继续追问、本轮无 features，图直接结束（functions=0 → END）
const DONE_CLAUSE = "以上需求已完整明确并定稿，请据此直接输出已确认的功能清单，不要再追问或补充。";
const requirement =
  (process.argv.slice(2).join(" ") ||
    "做一个多用户心理陪伴 Web 应用「日奈」，需要：用户注册登录（用户名+密码）、每个用户独立的会话空间（各自聊天记录互不可见）、聊天接口（用户消息传后端、LLM 回复返回）、服务端主动推送消息（WebSocket 长连接）" +
    DONE_CLAUSE)
  .trim();

// ---------- ① 图版 Manager：跑需求对话 → plan ----------
const questioner: Questioner = new CliQuestioner();
const manager = new Manager();
const state = await manager.run(
    { messages: [new HumanMessage(requirement)] },
    "hinaverse-demo",
    questioner,
);
const plan: any = state?.plan;
if (!plan || !Array.isArray(plan.phases) || plan.phases.length === 0) {
    console.error("[run-demo] PM 未产出有效 plan，退出。");
    process.exit(1);
}
console.log(`[run-demo] plan 产出：${plan.phases.length} 个阶段 → ${plan.phases.map((p: any) => `「${p.name}」`).join("、")}`);

// ---------- ② 注入技术栈（数据通道，非提示词） ----------
plan.techStack = TECH_STACK;

// ---------- ③ 建站 + 拉起消息版团队（并发常驻，不阻塞本脚本） ----------
const { station, team } = createTeam();
const teamRunning = team.map(a => a.start());   // 各自挂消息循环（永不退出，退出靠 process.exit）
console.log(`[run-demo] 团队已拉起：${Object.keys(station.status).join("、")}`);

// ---------- ④ 逐阶段下发，等 phase_request 当完成信号 ----------
for (let i = 0; i < plan.phases.length; i++) {
    const phase = plan.phases[i]!;
    station.sendMessage("manager", "architect", JSON.stringify({ type: "phase_plan", plan, phase, projectId: DEMO_PROJECT_ID }));
    console.log(`[run-demo] 阶段 ${phase.phase}「${phase.name}」已下发架构师。`);

    // 阻塞等架构师回 phase_request（阶段完成/放弃都会回）；允许多阶段消息排队，逐个消费
    while (true) {
        const msg = await station.waitForMessage("manager");
        if (!msg) continue;
        const data = JSON.parse(msg.content);
        if (data?.type !== "phase_request") continue;   // 其他杂物消息忽略
        if ((data.phase ?? phase.phase) === phase.phase || (data.phase ?? i + 1) >= (plan.phases[i]?.phase ?? i + 1)) {
            console.log(`[run-demo] 阶段 ${data.phase}「${phase.name}」完成（phase_request 收到）。`);
            break;
        }
    }
    station.markDone("manager");
}

// ---------- ⑤ 汇总退出 ----------
console.log("[run-demo] 全部阶段完成，流水线结束。");
process.exit(0);