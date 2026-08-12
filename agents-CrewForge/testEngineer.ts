import { ChatDeepSeek } from "@langchain/deepseek";
import { SystemMessage } from "@langchain/core/messages";
import * as z from "zod";
import { Annotation, StateGraph, START, END, MemorySaver, type GraphNode } from "@langchain/langgraph";
import fs from "node:fs";
import path from "node:path";
import { TransferStation, roles } from "./Hub.ts";   // 测试与合并器/开发/维护的消息中转站 + 角色枚举

// ============================================================
// 测试工程师：配对契约检查（纯 L3，LLM 模拟执行，零环境）
//
//   消息驱动：合并器配好对（pair_ready）→ 每组一次 LLM 判断
//   → 判过发维护计数；判错按 blame 发回对应开发（带问题清单，开发据此修代码）
//
// 消息协议（content 为 JSON 字符串）：
//   合并器 → 测试:  {"type": "pair_ready", "pair": {"back": ExecTask, "front": ExecTask|null}}
//   测试 → 开发:    {"type": "revision", "task": ExecTask, "issues": [问题清单]}  返工（blame 决定发给谁）
//   测试 → 维护:    {"type": "task_passed", "pair": {...}}  判过，维护计数
//
// 关键约定：
//   - 文件缺失 → 机械 fail，不调 LLM（反馈明确且省一次调用）
//   - 匹配问题（前端调的接口/传参/字段 vs 后端定义）由 LLM 归入出错的那一侧
// ============================================================

const model = new ChatDeepSeek({
    model: "deepseek-v4-flash",
})

// ---------- 类型定义 ----------

// 与架构师/工程师一致的 ExecTask
interface ExecTask {
  id: string;
  layer: "backend" | "frontend";
  method: string;
  path: string;
  files: string[];
  title: string;
  description: string;
  parameters: {
    name: string;
    type: string;
    required: boolean;
    description: string;
  }[];
  acceptance: string;
}

// 配对：一个接口的后端 + 前端（前端可能落单为空）
interface Pair {
  back: ExecTask;
  front: ExecTask | null;
}

// 测试结果（LLM 输出 + 机械预检）
interface Verdict {
  pass: boolean;
  blame: "backend" | "frontend" | "both";   // 归责：后端错 / 前端错 / 两边都错
  backendIssues: string[];
  frontendIssues: string[];
}

// ---------- 状态通道 ----------

const MessageState = Annotation.Root({
    pair: Annotation<Pair | null>({
        default: () => null,
        reducer: (_, u) => u,   // 每组一对任务
    }),
    verdict: Annotation<Verdict | null>({
        default: () => null,
        reducer: (_, u) => u,
    }),
    llmCalls: Annotation<number>({
        default: () => 0,
        reducer: (x, y) => x + y,
    }),
});

// ---------- 提示词 ----------

const test_prompt: string = `
# 角色定义
你是 CrewForge 项目的【测试-契约检查】Agent。你拿到一个接口的前后端任务和它们产出的代码文件，要判断契约是否被实现（纯代码阅读判断，不执行代码）。

## 输入
1. 后端任务（契约：method/path/入参/返回/验收标准）+ 后端产出代码
2. 前端任务（页面/交互/调用的接口/验收标准）+ 前端产出代码

## 判断三件事
1. 后端问题：路由是否按契约定义（method+path）、入参校验是否按参数契约、返回字段是否齐全、验收标准是否满足
2. 前端问题：页面交互是否实现（表单/校验/调接口/数据渲染）、验收标准是否满足
3. 匹配问题：前端调用的接口（method+path）是否和后端定义的一致？前端传参名/字段名是否和后端入参/返回对得上？——匹配问题归入出错的那一侧（谁错了写进谁的 issues）

## 输出（必须遵守）
只输出一段 JSON，不要夹带讨论：
{ "pass": true/false, "blame": "backend"|"frontend"|"both", "backendIssues": ["具体问题"], "frontendIssues": ["具体问题"] }

## 归责（blame）规则：结论必须明确到一侧或两侧
- 谁错了就归谁：只有后端问题→"backend"；只有前端问题→"frontend"；两边都错→"both"
- blame 必须和 issues 自洽：blame="backend" 则 backendIssues 非空、frontendIssues 为空；"both" 则两边都非空
- 匹配问题（前后端对不上）归入出错的那一侧，blame 跟着那一侧走
- pass=true 时 issues 留空数组，blame 填 "backend" 占位（调用方只看 pass）
- pass=false 时 issues 写清楚：哪里不对、期望是什么、实际是什么
`;

// ---------- 结构化输出模型 ----------

const verdictModel = model.withStructuredOutput(
  z.object({
    pass: z.boolean(),
    blame: z.enum(["backend", "frontend", "both"]),
    backendIssues: z.array(z.string()),
    frontendIssues: z.array(z.string()),
  }),
  { method: "jsonMode", name: "extract_verdict" }
);

// ---------- 工具 ----------

// 读任务产物文件（缺文件返回占位标记，机械预检会拦住）
function readTaskFiles(t: ExecTask): { filePath: string; content: string }[] {
  return t.files.map(fp => {
    const full = path.join("workspace", fp);
    if (!fs.existsSync(full)) return { filePath: fp, content: "（文件缺失：未产出）" };
    return { filePath: fp, content: fs.readFileSync(full, "utf-8") };
  });
}

// ---------- 节点 ----------

// 测试节点：机械预检（文件缺失直接 fail，省 LLM 调用）→ LLM 契约判断
const TestNode: GraphNode<typeof MessageState.State> = async (state) => {
    const pair = state.pair!;

    // 机械预检：文件缺失 → 直接 fail，不调 LLM（反馈明确）
    const missingBack = pair.back.files.filter(fp => !fs.existsSync(path.join("workspace", fp)));
    const missingFront = pair.front ? pair.front.files.filter(fp => !fs.existsSync(path.join("workspace", fp))) : [];
    if (missingBack.length > 0 || missingFront.length > 0) {
        // 归责按缺哪侧文件定：只缺后端→backend，只缺前端→frontend，都缺→both
        return {
            verdict: {
                pass: false,
                blame: missingBack.length > 0 && missingFront.length > 0 ? "both" : missingBack.length > 0 ? "backend" : "frontend",
                backendIssues: missingBack.map(fp => `文件未产出：${fp}`),
                frontendIssues: missingFront.map(fp => `文件未产出：${fp}`),
            },
        };
    }

    const backFiles = readTaskFiles(pair.back);
    const frontFiles = pair.front ? readTaskFiles(pair.front) : [];

    // LLM 调用失败（空输出/解析失败）→ 按 fail 处理，不崩流水线
    let parsed;
    try {
        parsed = await verdictModel.invoke([
            new SystemMessage(
                test_prompt +
                `\n\n## 后端任务（契约）\n${JSON.stringify(pair.back, null, 2)}` +
                `\n\n## 后端产出代码\n${backFiles.map(f => `--- ${f.filePath} ---\n${f.content}`).join("\n")}` +
                (pair.front
                    ? `\n\n## 前端任务（契约）\n${JSON.stringify(pair.front, null, 2)}` +
                      `\n\n## 前端产出代码\n${frontFiles.map(f => `--- ${f.filePath} ---\n${f.content}`).join("\n")}`
                    : "")
            ),
        ]);
    } catch (e) {
        // LLM 失败无法归责，保守按 both（issue 文案已写明是调用失败而非代码错误）
        return { verdict: { pass: false, blame: "both", backendIssues: [`LLM 调用失败：${(e as Error).message.slice(0, 100)}`], frontendIssues: [] } };
    }
    return { verdict: parsed, llmCalls: 1 };
};

// ---------- 组装图 ----------
// 单节点图：每组一对任务一次 invoke（每对独立 thread_id 断点）
const graph = new StateGraph(MessageState)
    .addNode("test", TestNode)
    .addEdge(START, "test")
    .addEdge("test", END)
    .compile({ checkpointer: new MemorySaver() });

// ---------- 消息驱动主流程 ----------

// 测试入口（函数化：接收 agent 名 + 共享中转站，由 start.ts 拉起）
// name = "testEngineer"/"test2"…（多测试负载均衡）
export async function runTest(name: string, station: TransferStation) {
    async function messageLoop() {
        console.log(`[${name}] 消息监听已启动：等合并器送配好的接口对`);
        while (true) {
            const msg = await station.waitForMessage(name);
            if (!msg) continue;
            let data: { type?: string; pair?: Pair };
            try { data = JSON.parse(msg.content); } catch { continue; }
            if (msg.sender !== "merger" || data.type !== "pair_ready" || !data.pair) continue;

            const pair = data.pair;
            const label = `${pair.back.id}${pair.front ? `+${pair.front.id}` : ""} ${pair.back.method} ${pair.back.path}`;
            console.log(`[${name}] ← 合并器：收到 ${label}`);

            // 契约判断（图：机械预检 + LLM；每对独立断点，可续跑）
            let v: Verdict;
            try {
                const state = await graph.invoke(
                    { pair },
                    { configurable: { thread_id: `t-${pair.back.id}` } }
                );
                v = state.verdict!;
                console.log(`[debug] llmCalls=${state.llmCalls}`);
            } catch (e) {
                v = { pass: false, blame: "both", backendIssues: [`测试图调用失败：${(e as Error).message.slice(0, 100)}`], frontendIssues: [] };
            }

            if (v.pass) {
                // 判过 → 维护计数（维护收齐任务才报阶段完成）
                station.sendMessage(name, "maintainer", JSON.stringify({ type: "task_passed", pair }));
                console.log(`[${name}] → 维护：${label} 通过`);
            } else {
                // 判错 → 按 blame 发回对应开发（revision 带问题清单，开发据此修改代码）
                // 多开发场景：目标用 pickLeastBusy(role) 选该角色负载最低的（不写死名字）
                const blame = v.blame === "both" ? "前后端都错" : v.blame === "backend" ? "后端错" : "前端错";
                console.log(`[${name}]：${label} 未通过（${blame}）`);
                if (v.blame === "backend" || v.blame === "both") {
                    const target = station.pickLeastBusy(roles.backendEngineer);
                    if (target) {
                        station.sendMessage(name, target, JSON.stringify({ type: "revision", task: pair.back, issues: v.backendIssues }));
                        v.backendIssues.forEach(i => console.log(`   后端：${i}`));
                    } else {
                        console.log(`⚠️ 没有后端开发注册，返工发送失败：${pair.back.id}`);
                    }
                }
                if (v.blame === "frontend" || v.blame === "both") {
                    if (pair.front) {
                        const target = station.pickLeastBusy(roles.frontendEngineer);
                        if (target) {
                            station.sendMessage(name, target, JSON.stringify({ type: "revision", task: pair.front, issues: v.frontendIssues }));
                            v.frontendIssues.forEach(i => console.log(`   前端：${i}`));
                        } else {
                            console.log(`⚠️ 没有前端开发注册，返工发送失败：${pair.front.id}`);
                        }
                    }
                }
            }
            station.markDone(name);   // 处理完记账（负载均衡的数据基础）
        }
    }

    // 挂住等消息（进程保持存活）
    await messageLoop();
}
