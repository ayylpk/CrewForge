import { ChatDeepSeek } from "@langchain/deepseek";
import * as z from "zod";
import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { TavilySearch } from "@langchain/tavily";
import { Annotation, StateGraph, START, END, MemorySaver, type GraphNode, messagesStateReducer } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import readline from "readline";

interface typeOfTasks{
  name: string,
  description: string,
  priority: string,
  acceptance: string
}

interface FunctionItem {
  name: string;
  description: string;
}

// 阶段（planItem）：轻量规划里每个阶段的结构
interface planItem {
  phase: number;
  name: string;
  goal: string;
  features: string[];      // 该阶段包含的功能名
  dependencies: string[];  // 依赖的阶段名
  relative_effort: string; // 大 | 中 | 小（不评估人天）
  risk: string;            // 高 | 中 | 低
}

// 最终产出：结构化 PRD + 阶段规划（替代 tasks 作为最终输出）
interface Plan {
  project: string;
  features: typeOfTasks[]; // 详细功能清单原样放回
  phases: planItem[];
  mvp_scope: string[];
  risks: string[];
}

const tasksReducer = (
  current: typeOfTasks[] = [],
  update: typeOfTasks[] | typeOfTasks
): typeOfTasks[] => {
  if (Array.isArray(update)) {
    return [...current, ...update];
  }
  return [...current, update];
};

// functionsReducer 的"追加"语义，加一条约定：
// 空数组 = 清空（dispose 节点细化完功能后用空数组清空）
// 所以新增功能时只传非空数组/单个对象，不传空数组
const functionsReducer = (
  current: FunctionItem[] = [],
  update: FunctionItem[] | FunctionItem
): FunctionItem[] => {
  if (Array.isArray(update) && update.length === 0) {
    return [];
  }
  if (Array.isArray(update)) {
    return [...current, ...update];
  }
  return [...current, update];
};

const model = new ChatDeepSeek({
    model: "deepseek-v4-flash",
})

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const pm_system_prompt: string = `
# 角色定义
你是 CrewForge 项目的【项目经理（PM）】，负责和用户对话，把用户的模糊想法变成清晰、可落地的需求，并和用户确认项目需要哪些功能。

## 工作目标
通过一轮轮对话完成三件事：
1. 需求澄清：搞清楚用户到底想做什么、解决什么问题
2. 功能确认：和用户对齐"项目需要哪些功能"，并确认每个功能的优先级
3. 输出清单：需求确认完成后，输出功能清单 JSON 交给下游（功能细化）消费

## 可用工具
- web_search（Tavily 联网搜索）：查行业信息、竞品、价格行情、真实数据时使用；平时不需要。

## 对话策略（核心）
- 开场让用户自由说：先请用户描述想法（"你想做什么？"），不要一上来就列问题清单
- 每次只问 1~3 个问题，避免问卷式轰炸；用户回答后先复述确认，再问下一个
- 按这个顺序逐步收敛：
  1. 做什么：用户想解决什么问题、达成什么目标
  2. 给谁用：目标用户是谁，单人用还是多人用
  3. 怎么用：核心使用场景，用户会怎么操作
  4. 现状与痛点：现在是怎么做的、哪里不满意
  5. 必须 vs 想要：哪些功能绝对不能少，哪些可以有
  6. 边界与规模：大概多少人用、数据量多大、有没有合规要求
- 复述确认：用户讲完一段后，用一句话总结"我理解你的需求是……对吗？"，确认没跑偏
- 主动追问模糊点：用户说得太泛（如"做个管理后台"）时，追问具体管理什么、谁来操作，不要靠猜
- 发现矛盾或遗漏（如列了一堆功能但没说给谁用）时，指出来并提问，不要默默假设

## 边界（严格遵守）
- 不细化功能细节（功能细化交给下游节点）、不写代码、不做技术选型
- 不擅自替用户决定功能 —— 功能清单必须经过用户确认

## 输出格式（必须遵守）
【铁律】每次用户确认了新功能，你必须在本轮回复的最后输出一次 {"features": [...]} JSON——系统靠它入库，光在对话里列文字清单无效。JSON 必须是回复的最后一段，输出后不要再写任何文字（不要在前面铺垫"我记录一下"这类话，也不要后面跟"感谢"等收尾语）。
每次回复按场景在末尾输出 JSON（二选一，没输出就正常聊）：
1. 本轮确认了新功能 → 输出 {"features": [...]}，只放【本轮新确认】的，不要重复放之前确认过的：
{
  "features": [
    {
      "name": "功能名",
      "description": "功能做什么",
      "priority": "高 | 中 | 低",
      "acceptance": "可验证的验收标准"
    }
  ]
}
2. 用户明确表示功能确认完毕（如"就这些了""没别的了""定稿""没问题""可以""就这样吧"）→ 输出 {"done": true}
注意：
- 确认新功能时【必须】输出 features JSON，文字列清单不算数
- features 只放本轮新确认的，避免重复累积
- 只有用户确认完毕时才输出 done；done 那一轮不要输出 features（done 轮不重复输出清单）
- 每个 feature 都要有明确的 acceptance，且经过用户确认
- 用户中途想加需求，就回到对话继续确认，不要急着输出 done

## 沟通风格
- 说人话：避免技术术语，用用户听得懂的话提问
- 简洁：一个问题只问一件事，必要时给例子（"比如……"）
- 耐心：用户没说清楚就换个问法，不重复问同样的话
- 必须遵循： 不可以使用**描述**这种形式。
`

// 功能细化提示词：把模糊功能变成详细确认版（task = 功能的详细阐释，不是实现任务）
const detail_system_prompt: string = `
# 角色定义
你是 CrewForge 项目的【需求细化员】，负责把项目经理（PM）确认好的【模糊功能】细化为【详细确认版】。

## 工作目标
对每个模糊功能做详细阐释，让功能描述从"一句话"变成"可验收的完整描述"：
- 功能做什么：用户怎么用、核心流程是什么
- 细节边界：包含什么、不包含什么
- 验收标准：怎么算这个功能做完了

## 输入
你会收到一份已确认的功能清单（功能名 + 描述），逐个细化，不要自己发明新功能。

## 输出格式（必须遵守）
最后输出一段 JSON，字段固定为 tasks（详细确认版功能）：
{
  "tasks": [
    {
      "name": "功能名",
      "description": "详细的功能阐释：用户怎么用、核心流程、边界",
      "priority": "高 | 中 | 低",
      "acceptance": "可验证的验收标准"
    }
  ]
}
注意：
- 一个功能对应一个 task，是一一对应的确认，不是拆解成实现步骤
- description 要比输入更详细具体，但不要引入新功能
- 只输出 JSON，不要夹带其他讨论
`

// 规划提示词：轻量阶段规划（最终输出 plan，替代 tasks 展示）
const plan_system_prompt: string = `
# 角色定义
你是 CrewForge 项目的【功能结构化 Agent】。

## 核心职责
1. 接收功能列表，输出结构化 PRD
2. 额外输出：轻量级阶段规划

## 输入
你会收到一份【已确认的详细功能清单】（含每个功能的描述、优先级、验收标准），直接基于它规划，不要自己发明新功能。

## 阶段规划规则
- 将功能按依赖关系拆分为 2~4 个阶段
- 标注每个阶段的 goal（一句话目标）
- 标注阶段之间的依赖关系
- 标注 MVP 范围（第一版必须上的功能）
- 不评估具体人天（用 大/中/小 表示相对工作量）
- 不涉及技术选型

## 输出格式（必须遵守）
只输出一段 JSON，不要夹带其他讨论：
{
  "project": "项目名称",
  "features": [详细功能清单原样放回],
  "phases": [
    {
      "phase": 1,
      "name": "阶段名称",
      "goal": "这个阶段完成什么目标",
      "features": ["功能1", "功能2"],
      "dependencies": [],
      "relative_effort": "大 | 中 | 小",
      "risk": "高 | 中 | 低"
    }
  ],
  "mvp_scope": ["功能1", "功能2"],
  "risks": ["需要提前关注的风险"]
}
`

const tavilySearchTool = new TavilySearch({
  maxResults: 3,
  searchDepth: "basic", 
  includeAnswer:true,
});

const tools = [tavilySearchTool];

// 工具名 → 工具实例 的映射，后面 ToolNode 按名字找工具用
// （不用断言类型，TS 会自己推断成 Record<string, TavilySearch>）
const toolsByName = Object.fromEntries(
    tools.map(t => [t.name, t])
);

const modelWithTools = model.bindTools(tools);

// 工具执行节点：模型要求调工具（如 web_search）时在这里真实执行
const toolNode = new ToolNode(tools);

const MessagesState = Annotation.Root({
    messages: Annotation<BaseMessage[]>({
        default: () => [],
        reducer: messagesStateReducer,  
    }),
    functions: Annotation<FunctionItem[]>({
        default: () => [],
        reducer: functionsReducer
    }),
    tasks: Annotation<typeOfTasks[]>({
        default: () => [],
        reducer: tasksReducer
    }),
    llmCalls: Annotation<number>({
        default: () => 0,
        reducer: (x, y) => x + y,
    }),
    numberOfTasks: Annotation<number>({
        default: () => 0,
        reducer: (x, y) => x + y,
    }),
    flag: Annotation<boolean>({
      default: () => false,
      reducer: (current, update) => update,
    }),
    plan: Annotation<Plan | null>({
      default: () => null,
      // 覆盖写：每次规划都整体替换
      reducer: (current, update) => update,
    })
});


// 从文本里提取"能解析的 JSON"：从后往前找 { 开头、括号配对的平衡块
// （模型经常把裸 JSON 夹在对话文字中间，直接整段 JSON.parse 会死在中文上）
// acceptedKeys：只认包含这些键的对象 —— 否则会抓到嵌套 JSON 里最内层的单条 fragment
function extractJsonBlock(text: string, acceptedKeys: string[]): string | null {
  let idx = text.length;
  while (idx > 0) {
    const start = text.lastIndexOf("{", idx - 1);
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try {
            const data = JSON.parse(candidate);
            if (data && typeof data === "object" && acceptedKeys.some((k) => k in data)) {
              return candidate;
            }
          } catch {
          }
          break;
        }
      }
    }
    idx = start;
  }
  return null;
}

// 从 PM 的最新回复里解析：本轮新确认的功能 + 是否确认完成（done）
function parsePMResponse(response: BaseMessage): { newFunctions: FunctionItem[]; done: boolean } {
  const text = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
  // 1. 优先找 ```json 代码块
  const codeMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  // 2. 没有代码块就提取文字中间夹的裸 JSON 平衡块
  const jsonText = codeMatch?.[1] ?? extractJsonBlock(text, ["features", "done"]) ?? text;
  try {
    const data = JSON.parse(jsonText.trim());
    return {
      newFunctions: Array.isArray(data.features) ? data.features : [],
      done: data.done === true,
    };
  } catch {
    return { newFunctions: [], done: false }; // 这轮没有 JSON 就正常对话
  }
}

// PM 节点：对话确认功能（确认一个写一个进 functions）
const llmCalls: GraphNode<typeof MessagesState.State> = async (state) => {
  // 系统提示词 + 完整对话历史拼一起发给模型
  const response = await modelWithTools.invoke([
    new SystemMessage(pm_system_prompt),
    ...state.messages,
  ]);
  // 如果模型要求调工具（如 web_search），本轮先不解析功能，
  // 让 ToolNode 执行工具后回到本节点继续对话
  const hasToolCalls = response.tool_calls !== undefined && response.tool_calls.length > 0;
  const { newFunctions, done } = hasToolCalls ? { newFunctions: [], done: false } : parsePMResponse(response);
  // messages：追加模型回复；llmCalls：加 1
  // functions：有新的才写（空数组会被 reducer 当成"清空"信号，所以没新功能时干脆不带这个字段）
  // flag：PM 任务是否完成
  return {
    messages: [response],
    ...(newFunctions.length > 0 ? { functions: newFunctions } : {}),
    flag: done,
    llmCalls: 1,
  };
};

// 功能细化节点：把已确认的模糊功能细化为详细确认版，然后清空 functions
// 用 withStructuredOutput 强制结构化输出——模型直接返回对象，不用再从文本里抠 JSON
const disposeModel = model.withStructuredOutput(
  z.object({
    tasks: z.array(z.object({
      name: z.string(),
      description: z.string(),
      priority: z.string(),
      acceptance: z.string(),
    })),
  }),
  { method: "functionCalling", name: "extract_tasks" }
);

const dispose: GraphNode<typeof MessagesState.State> = async (state) => {
  // 1. 把功能清单格式化成文字，拼进系统提示词
  const functions: FunctionItem[] = state.functions;
  const functionsContent = functions
    .map((fn, index) => `${index + 1}. ${fn.name}: ${fn.description}`)
    .join('\n');

  // 2. 结构化输出直接拿 tasks（无兜底：schema 校验失败会抛错，由外层 catch 接住）
  const parsed = await disposeModel.invoke([
    new SystemMessage(detail_system_prompt + '\n\n## 功能清单\n' + functionsContent),
  ]);

  // 3. 返回更新：tasks 追加、numberOfTasks 累加、functions 用空数组清空（reducer 约定）
  return { tasks: parsed.tasks, numberOfTasks: parsed.tasks.length, functions: [] };
}

// 规划节点：根据详细确认的功能（tasks）做轻量规划，产出 plan（最终输出）
// 结构化输出，无兜底
const plannerModel = model.withStructuredOutput(
  z.object({
    project: z.string(),
    features: z.array(z.object({
      name: z.string(),
      description: z.string(),
      priority: z.string(),
      acceptance: z.string(),
    })),
    phases: z.array(z.object({
      phase: z.number(),
      name: z.string(),
      goal: z.string(),
      features: z.array(z.string()),
      dependencies: z.array(z.string()),
      relative_effort: z.string(),
      risk: z.string(),
    })),
    mvp_scope: z.array(z.string()),
    risks: z.array(z.string()),
  }),
  { method: "functionCalling", name: "extract_plan" }
);

const planner: GraphNode<typeof MessagesState.State> = async (state) => {
  // 1. 把详细功能清单格式化成文字
  const tasksContent = state.tasks
    .map((t, i) => `${i + 1}. ${t.name}（${t.priority}）：${t.description} | 验收：${t.acceptance}`)
    .join('\n');

  // 2. 结构化输出直接拿 plan（无兜底：失败即抛错）
  const plan = await plannerModel.invoke([
    new SystemMessage(plan_system_prompt + '\n\n## 已确认的详细功能清单\n' + tasksContent),
  ]);

  // 3. 覆盖写进 state.plan
  return { plan };
}

// 路由节点（条件边）：PM 回复后决定图往哪走
const afterPm = (state: typeof MessagesState.State): "tools" | "dispose" | "__end__" => {
  // 1. 模型要求调工具（如 web_search）→ 去 ToolNode 执行，执行完回到 pm 继续对话
  const lastMessage = state.messages[state.messages.length - 1] as { tool_calls?: unknown[] };
  if (lastMessage?.tool_calls && lastMessage.tool_calls.length > 0) return "tools";
  // 2. 有已确认的功能 → 去细化（先 functions 后 flag 的顺序）
  if (state.functions.length > 0) return "dispose";
  // 3. 没有待细化的功能 → 本轮图结束（flag 由应用层读取，决定整个对话是否收尾）
  return "__end__";
};

// 组装图：START → PM 对话 → 路由 →（有功能就）细化 → 规划 → END
// 注意：节点名不能和状态通道名重名（llmCalls 已是通道名，所以节点叫 pm；plan 是通道名，节点叫 planner）
// checkpointer：MemorySaver + 相同 thread_id = 状态跨轮保存（否则每轮 invoke 状态都会重置）
const graph = new StateGraph(MessagesState)
  .addNode("pm", llmCalls)
  .addNode("tools", toolNode)
  .addNode("dispose", dispose)
  .addNode("planner", planner)
  .addEdge(START, "pm")
  .addConditionalEdges("pm", afterPm)
  .addEdge("tools", "pm") // 工具执行完回到 PM 继续对话
  .addEdge("dispose", "planner")
  .addEdge("planner", END)
  .compile({ checkpointer: new MemorySaver() });

async function main() {
  console.log("我是你的项目经理助手,请告诉我你想要一个什么样子的项目，有哪些功能和需求");
  console.log("输入 'exit' 退出程序\n");

  while(true){
    const userInput = await new Promise<string>((resolve) => {
      rl.question("你: ",resolve);
    });

    if(userInput.toLocaleLowerCase() === "exit"){
      console.log("再见，祝你项目顺利！")
      break;
    }

    if(!userInput.trim()) continue;

    try{
      // 每次只传新消息：对话历史 + 状态（functions/tasks/plan/flag）
      // 由 checkpoint（MemorySaver + 相同 thread_id）自动跨轮保存
      const result = await graph.invoke(
        { messages: [new HumanMessage(userInput)] },
        { configurable: { thread_id: "pm-session" } }
      );

      const finalMessage = result.messages[result.messages.length - 1];

      if(!finalMessage){
        console.log("助手:请您详细说明一下。\n");
        continue;
      }
      console.log(`\n助手: ${finalMessage.content}\n`);

      // flag 为 true = 项目经理工作完成 → 展示最终规划（plan 替代 tasks 作为最终输出）
      if (result.flag) {
        // debug：排查用（看 functions/tasks/plan 各走了多少），稳定后可删
        console.log(`[debug] functions=${result.functions.length} tasks=${result.tasks.length} plan=${result.plan ? "有" : "无"}`);
        if (result.plan) {
          console.log(`\n========== 项目规划：${result.plan.project} ==========`);
          console.log(`MVP 范围：${result.plan.mvp_scope.join("、")}`);
          result.plan.phases.forEach((p) => {
            console.log(`\n阶段 ${p.phase}：${p.name}（工作量 ${p.relative_effort}，风险 ${p.risk}）`);
            console.log(`  目标：${p.goal}`);
            console.log(`  功能：${p.features.join("、")}`);
          });
          console.log(`\n风险：${result.plan.risks.join("；")}`);
          console.log("============================================");
        } else {
          console.log("\n⚠️ 规划未生成（plan 为空），请重试。");
        }
        break;
      }
    } catch (error) {
      console.error("出错了:", error);
      console.log("助手: 抱歉，处理你的请求时遇到了问题，请稍后再试。\n");
    }
  }

  rl.close();
}

main();
