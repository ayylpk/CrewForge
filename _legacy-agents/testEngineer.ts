import { SystemMessage } from "@langchain/core/messages";
import * as z from "zod";
import { Annotation, StateGraph, START, END, MemorySaver, type GraphNode } from "@langchain/langgraph";
import fs from "node:fs";
import path from "node:path";
import { TransferStation, roles, llmWithTimeout } from "./Hub.ts";   // 测试与合并器/开发/维护的消息中转站 + 角色枚举 + 超时兜底
import { getModel, getModelRequestTimeout } from "./modelRegistry.ts";

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

const model = getModel("review");

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
# 角色
你是 CrewForge 项目的测试-契约检查 Agent。你只通过阅读任务契约和代码判断实现是否满足要求，不执行代码，也不替换开发者做设计。

## 输入
1. 后端任务（契约：method/path/入参/返回/验收标准）+ 后端产出代码
2. 前端任务（页面/交互/调用的接口/验收标准）+ 前端产出代码

## 检查顺序
1. 后端：核对 method、path、参数名与必填性、返回字段、错误处理和后端验收标准。
2. 前端：核对页面交互、表单校验、请求调用、参数组装、响应渲染和前端验收标准。
3. 集成契约：核对前端调用的 method/path、请求字段和响应字段是否与后端完全一致。
4. 每个问题都要引用可定位的实际行为，说明期望和实际；没有证据的问题不要提出。

## 输出
只输出合法 JSON，不要 Markdown、解释或额外字段：
{ "pass": true/false, "blame": "backend"|"frontend"|"both", "backendIssues": ["具体问题"], "frontendIssues": ["具体问题"] }

## 归责
结论必须明确到一侧或两侧：
- 谁错了就归谁：只有后端问题→"backend"；只有前端问题→"frontend"；两边都错→"both"
- blame 必须和 issues 自洽：blame="backend" 则 backendIssues 非空、frontendIssues 为空；"both" 则两边都非空
- 匹配问题（前后端对不上）归入出错的那一侧，blame 跟着那一侧走
- pass=true 时 issues 留空数组，blame 填 "backend" 占位（调用方只看 pass）
- pass=false 时，每条 issue 写清楚位置、期望行为和实际行为；问题应足够具体，使开发 Agent 可以直接修改。
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
        parsed = await llmWithTimeout(
            sig => verdictModel.invoke([
                new SystemMessage(
                    test_prompt +
                    `\n\n## 后端任务（契约）\n${JSON.stringify(pair.back, null, 2)}` +
                    `\n\n## 后端产出代码\n${backFiles.map(f => `--- ${f.filePath} ---\n${f.content}`).join("\n")}` +
                    (pair.front
                        ? `\n\n## 前端任务（契约）\n${JSON.stringify(pair.front, null, 2)}` +
                          `\n\n## 前端产出代码\n${frontFiles.map(f => `--- ${f.filePath} ---\n${f.content}`).join("\n")}`
                        : "")
                ),
            ], { signal: sig }),
            getModelRequestTimeout("review"), `测试判定 ${pair.back.id}`
        );
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
    const judgementCount = new Map<string, number>();   // pairId → 判定次数：≥3 次未过放弃（防 revision 无限循环）

    async function messageLoop() {
        console.log(`[${name}] 消息监听已启动：等合并器送配好的接口对`);
        while (true) {
            const msg = await station.waitForMessage(name);
            if (!msg) { station.markDone(name); continue; }
            let data: { type?: string; pair?: Pair; phase?: number };
            try { data = JSON.parse(msg.content); } catch { station.markDone(name); continue; }
            if (msg.sender !== "merger" || data.type !== "pair_ready" || !data.pair) { station.markDone(name); continue; }

            const pair = data.pair;
            const pairKey = pair.back.id;
            const phase = data.phase ?? 1;
            const label = `${pairKey}${pair.front ? `+${pair.front.id}` : ""} ${pair.back.method} ${pair.back.path}`;
                console.log(`[${name}] 收到合并器的接口对：${label}`);

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
                // 判过 → 维护计数（维护收齐任务才报阶段完成）；带阶段号防跨阶段迟到消息污染记账
                station.sendMessage(name, "maintainer", JSON.stringify({ type: "task_passed", phase, pair }));
                console.log(`[${name}] 发送到维护：${label} 通过`);
            } else {
                // 判定轮次上限：同一对同一阶段 ≥3 次未过 → 放弃（防开发修不好无限循环）
                // 计数按 阶段:pairId 键控：任务 id 每阶段从 T1 重新编号，跨阶段不得累加
                const countKey = `${phase}:${pairKey}`;
                const count = (judgementCount.get(countKey) ?? 0) + 1;
                judgementCount.set(countKey, count);
                if (count >= 3) {
                    station.sendMessage(name, "maintainer", JSON.stringify({ type: "task_failed", phase, pairId: pairKey }));
                    // 同时通知合并器停止为该对继续配对（迟到的返工结果不再复活它）
                    station.sendMessage(name, "merger", JSON.stringify({ type: "task_failed", pairId: pairKey }));
                    console.log(`[${name}] 提示：${label} 判定 ${count} 次仍未通过，放弃并上报维护`);
                } else {
                    // 判错 → 按 blame 发回对应开发（revision 带问题清单，开发据此修改代码）
                    // 多开发场景：目标用 pickLeastBusy(role) 选该角色负载最低的（不写死名字）
                    const blame = v.blame === "both" ? "前后端都错" : v.blame === "backend" ? "后端错" : "前端错";
                    console.log(`[${name}]：${label} 未通过（${blame}，第 ${count} 次判定）`);
                    if (v.blame === "backend" || v.blame === "both") {
                    const target = station.pickLeastBusy(roles.backendEngineer);
                    if (target) {
                        station.sendMessage(name, target, JSON.stringify({ type: "revision", task: pair.back, issues: v.backendIssues }));
                        v.backendIssues.forEach(i => console.log(`   后端：${i}`));
                    } else {
                            console.log(`提示：没有后端开发注册，返工发送失败：${pair.back.id}`);
                    }
                }
                if (v.blame === "frontend" || v.blame === "both") {
                    if (pair.front) {
                        const target = station.pickLeastBusy(roles.frontendEngineer);
                        if (target) {
                            station.sendMessage(name, target, JSON.stringify({ type: "revision", task: pair.front, issues: v.frontendIssues }));
                            v.frontendIssues.forEach(i => console.log(`   前端：${i}`));
                        } else {
                            console.log(`提示：没有前端开发注册，返工发送失败：${pair.front.id}`);
                        }
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
