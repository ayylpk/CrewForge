import { ChatDeepSeek } from "@langchain/deepseek";
import { SystemMessage } from "@langchain/core/messages";
import * as z from "zod";
import { Annotation, StateGraph, START, END, MemorySaver, type GraphNode } from "@langchain/langgraph";
import fs from "node:fs";
import path from "node:path";

// ============================================================
// 维护工程师（v1）：任务收尾（发布管家，不写业务、不碰 git、不做集成冒烟）
//
//   每任务：机械落盘确认（files 都在 workspace/？）→ LLM 交付说明
//   （做了什么/改了哪些文件/怎么验证）→ 控制台输出（演示版：agent 间不通信）
//
// 关键约定：
//   - 落盘确认是机械的（文件存在性），LLM 只写交付说明
//   - 交付说明按任务原子（任务 = 原子铁律）
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

// 交付说明（LLM 输出）
interface Handover {
  done: string;          // 做了什么
  filesChanged: string[]; // 改了哪些文件
  howToVerify: string;    // 怎么验证
}

// ---------- 状态通道 ----------

const MessageState = Annotation.Root({
    task: Annotation<ExecTask | null>({
        default: () => null,
        reducer: (_, u) => u,
    }),
    handover: Annotation<Handover | null>({
        default: () => null,
        reducer: (_, u) => u,
    }),
    llmCalls: Annotation<number>({
        default: () => 0,
        reducer: (x, y) => x + y,
    }),
});

// ---------- 提示词 ----------

const handover_prompt: string = `
# 角色定义
你是 CrewForge 项目的【维护-交付说明】Agent。你负责给一个已完成的任务写交付说明（发布管家：不写业务代码，只管"东西能交出去、跑得起来"）。

## 输入
1. 任务（契约 + 描述 + 验收标准）
2. 该任务产出的代码文件

## 工作目标
写一份给接手人的交付说明：
1. done：这个任务做了什么（一句话到两三句，业务视角）
2. filesChanged：改了/新建了哪些文件（按文件列，说明每个文件的作用）
3. howToVerify：怎么验证这个任务做对了（对照验收标准，给出具体的验证步骤——如调用哪个接口、页面怎么操作、看什么结果）

## 输出（必须遵守）
只输出一段 JSON，不要夹带讨论：
{ "done": "做了什么", "filesChanged": ["文件1：作用", "文件2：作用"], "howToVerify": "怎么验证" }
`;

// ---------- 结构化输出模型 ----------

const handoverModel = model.withStructuredOutput(
  z.object({
    done: z.string(),
    filesChanged: z.array(z.string()),
    howToVerify: z.string(),
  }),
  { method: "jsonMode", name: "extract_handover" }
);

// ---------- 工具 ----------

function readTaskFiles(t: ExecTask): { filePath: string; content: string }[] {
  return t.files.map(fp => {
    const full = path.join("workspace", fp);
    if (!fs.existsSync(full)) return { filePath: fp, content: "（文件缺失）" };
    return { filePath: fp, content: fs.readFileSync(full, "utf-8") };
  });
}

// ---------- 节点 ----------

// 交付说明节点：读任务产物 → LLM 写交付说明
const HandoverNode: GraphNode<typeof MessageState.State> = async (state) => {
    const task = state.task!;
    const files = readTaskFiles(task);

    // LLM 调用失败（空输出/解析失败）→ 控制台标注，不崩流水线
    let parsed;
    try {
        parsed = await handoverModel.invoke([
            new SystemMessage(
                handover_prompt +
                `\n\n## 任务\n${JSON.stringify(task, null, 2)}` +
                `\n\n## 产出代码\n${files.map(f => `--- ${f.filePath} ---\n${f.content}`).join("\n")}`
            ),
        ]);
    } catch (e) {
        return { handover: { done: `（LLM 调用失败：${(e as Error).message.slice(0, 80)}）`, filesChanged: [], howToVerify: "" } };
    }
    return { handover: parsed, llmCalls: 1 };
};

// ---------- 组装图 ----------
// 单节点图：每任务一次 invoke（每任务独立 thread_id 断点）
// 注意：节点名不能和状态通道名重名（handover 是通道，节点叫 handoverNode）
const graph = new StateGraph(MessageState)
    .addNode("handoverNode", HandoverNode)
    .addEdge(START, "handoverNode")
    .addEdge("handoverNode", END)
    .compile({ checkpointer: new MemorySaver() });

// ---------- 主流程 ----------

async function main() {
    const all = JSON.parse(fs.readFileSync("tasks.json", "utf-8")) as ExecTask[];
    console.log(`维护收尾：${all.length} 个任务\n`);

    let llmCalls = 0;
    for (const task of all) {
        console.log(`========== ${task.id} ${task.title} ==========`);

        // 机械落盘确认：files 是否都在 workspace/
        const missing = task.files.filter(fp => !fs.existsSync(path.join("workspace", fp)));
        if (missing.length > 0) {
            console.log(`⚠️ 落盘不完整，缺文件：${missing.join("、")}（后续任务可能没跑或产出为空）\n`);
            continue;   // 缺文件不写交付说明（没法验）
        }
        console.log(`✓ 落盘确认：${task.files.length} 个文件都在`);

        const state = await graph.invoke(
            { task },
            { configurable: { thread_id: `m-${task.id}` } }
        );
        const h = state.handover!;
        llmCalls += state.llmCalls;

        console.log(`  交付说明：${h.done}`);
        console.log(`  文件：`);
        h.filesChanged.forEach(f => console.log(`    - ${f}`));
        console.log(`  怎么验证：${h.howToVerify}\n`);
    }
    console.log(`维护收尾完成${llmCalls ? `，llmCalls=${llmCalls}` : ""}`);
}

main();
