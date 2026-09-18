// ============================================================
// GraphFactory.ts —— DB 声明 → 节点 → 拼接成图（核心拼接层）
//
// 设计原则：DB 存"声明"（节点类型、prompt、连边、条件），
// 代码注册表存"实现"（纯代码节点函数体、zod schema、条件判断）。
// JS 函数体永远不进数据库。
//
// 三个注册表（新增一个 agent 的纯逻辑节点 = register 一行）：
//   codeRegistry    node_type="code" 的节点函数（state => 部分更新）
//   schemaRegistry  结构化输出的 zod schema（node.schemaKey 引用）
//   condRegistry    条件边判断（edge.condition 引用）
// ============================================================

import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { SystemMessage } from "@langchain/core/messages";
import { Annotation, StateGraph, START, END, MemorySaver, type GraphNode } from "@langchain/langgraph";
import { type Node, type Edge } from "./Node";
import { initModels } from "./models";
import { invokeWithTimeout, retryStructuredResult, StructuredOutputFailure, DEFAULT_TIMEOUT_MS } from "./llm";

// ---------- 注册表 ----------

export type StateNodeFn = (state: any, node?: Node) => any;   // 返回本节点 output 通道的值（或整份 partial state，见 createNodeFromRow）；node 是 DB 节点声明（含 systemPrompt 等，code 节点可读）

export class CodeRegistry {
    private fns = new Map<string, StateNodeFn>();
    register(key: string, fn: StateNodeFn) { this.fns.set(key, fn); }
    get(key: string): StateNodeFn {
        const fn = this.fns.get(key);
        if (!fn) throw new Error(`代码注册表缺少节点：${key}（记得在启动时 register）`);
        return fn;
    }
}
export const codeRegistry = new CodeRegistry();

export class SchemaRegistry {
    private schemas = new Map<string, any>();
    register(key: string, schema: any) { this.schemas.set(key, schema); }
    get(key: string): any {
        const s = this.schemas.get(key);
        if (!s) throw new Error(`schema 注册表缺少：${key}`);
        return s;
    }
}
export const schemaRegistry = new SchemaRegistry();

// ============================================================
// 节点级输出校验器（搬运⑤修订，2026-09-17）
//   schema 管形状，这里管"值与上下文的一致性"——校验器能拿到**图状态**
//   （需求原文在 state 里，不依赖模型自觉吐新字段，那是 s4b 炸掉的写法）。
//   返回问题短句列表（空=绿）；非空 → llmNode 在重试回调内抛错，
//   报错原文带出路喂回模型，走既有 OUTPUT_PARSE 有界重试。
// ============================================================
export type NodeOutputValidator = (value: any, state: any) => string[] | Promise<string[]>;
const nodeValidators = new Map<string, NodeOutputValidator>();
export function registerNodeValidator(schemaKey: string, fn: NodeOutputValidator): void {
    nodeValidators.set(schemaKey, fn);
}
function nodeValidatorOf(schemaKey: string | null | undefined): NodeOutputValidator | null {
    return schemaKey ? nodeValidators.get(schemaKey) ?? null : null;
}

export type CondFn = (state: any) => boolean;

export class CondRegistry {
    private fns = new Map<string, CondFn>();
    register(key: string, fn: CondFn) { this.fns.set(key, fn); }
    get(key: string): CondFn {
        const fn = this.fns.get(key);
        if (!fn) throw new Error(`条件注册表缺少：${key}`);
        return fn;
    }
}
export const condRegistry = new CondRegistry();

// ---------- 用户交互（HumanGate + Questioner） ----------

export interface HumanQuestion {
    questionId: string;
    prompt: string;
    options?: string[];
}

// 提问器接口：CLI 版阻塞读 stdin；消息版等 human_answer 消息回来
export interface Questioner {
    ask(q: HumanQuestion): Promise<string>;
}

// CLI 版（现状 architect/manager 的做法，隔离成接口，图逻辑不用动）
export class CliQuestioner implements Questioner {
    private rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    ask(q: HumanQuestion): Promise<string> {
        if (process.env.AUTO_CONFIRM === "1") return Promise.resolve("y");   // CI/演示自动确认
        const hint = q.options ? `（${q.options.join(" / ")}）` : "";
        return new Promise(res => this.rl.question(`${q.prompt}${hint} `, res));
    }
}

// 消息版（Web/多用户）：问题发出去，答案以 human_answer 消息回来，agent 进程不阻塞
export class MessageQuestioner implements Questioner {
    private pending = new Map<string, (a: string) => void>();
    private emit: (q: HumanQuestion) => void;
    constructor(emit: (q: HumanQuestion) => void) { this.emit = emit; }
    ask(q: HumanQuestion): Promise<string> {
        return new Promise(res => { this.pending.set(q.questionId, res); this.emit(q); });
    }
    resume(questionId: string, answer: string) { this.pending.get(questionId)?.(answer); this.pending.delete(questionId); }
}

// 图内交互门：不阻塞！把问题写进 state.human 并结束本轮（graph.invoke 正常返回）。
// 外层循环看到 state.human → questioner.ask → graph.invoke({ humanAnswer }) 续跑。
// 幂等：humanAnswer 已给 → 清空放行（条件边据此继续）。这正是 architect 确认门的通用化。
export function humanGate(prompt: string | ((state: any) => string), options?: string[]): GraphNode<any> {
    return async (state: any) => {
        if (state.humanAnswer != null) return { human: null, humanAnswer: null };
        return { human: { questionId: randomUUID(), prompt: typeof prompt === "function" ? prompt(state) : prompt, options } };
    };
}

// 内置条件：human 被清空 = 答案已给（配 human 节点用）
condRegistry.register("human_answered", (state) => state.human == null);

// ---------- 节点工厂（一行 DB 记录 → 一个可执行节点） ----------

function extractJson(content: unknown): any {
    const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("模型未返回 JSON");
    return JSON.parse(text.slice(start, end + 1));
}

// DB 节点声明 → T3 分层角色（schemaKey/codeKey 前缀约定：architect_* / manager_*）；认不出=不分层（全局名行为）
function graphRoleOf(row: Node): string | undefined {
    const key = `${row.schemaKey ?? ""} ${row.codeKey ?? ""}`;
    if (key.includes("architect_")) return "architect";
    if (key.includes("manager_")) return "manager";
    return undefined;
}

function llmNode(row: Node): GraphNode<any> {
    const output = row.output;
    if (!output) throw new Error(`llm 节点 ${row.nodeName} 缺 output 列（产出通道名，如 plan/tasks）`);
    const timeoutMs = row.timeoutMs ?? DEFAULT_TIMEOUT_MS; // 单次调用超时（DB 可配）

    // 惰性初始化：模型和 schema 在首次执行时才解析。
    // 好处：① 构造图不需要 DEEPSEEK_API_KEY（没有 key 也能 build，调用时才报错）
    //      ② 不要求 schema 注册顺序（build 时注册表还没填也不炸）。
    let model: ReturnType<typeof initModels> | undefined;
    let schema: any;
    let schemaReady = false;

    return async (state: any) => {
        // ★ 阶段 1 提交 1：模型/schema 解析也放进重试回调里——否则 initModels 抛错会绕过
        //   "有界重试 + 结构化失败"，又变成裸异常冒泡（正是 s2 的死法）。
        const res = await retryStructuredResult<any>(
            `llm:${row.nodeName}`,
            async (feedback, sig) => {
                if (!model) model = initModels(row.model || "{}", graphRoleOf(row));
                if (!schemaReady) {
                    schema = row.schemaKey ? schemaRegistry.get(row.schemaKey) : null;
                    schemaReady = true;
                }
                const prompt = `${row.systemPrompt}\n\n## 输入\n${JSON.stringify(state, null, 2)}` + feedback;
                const messages = [new SystemMessage(prompt)];
                const out = await invokeWithTimeout<any>(row.nodeName, timeoutMs, (s) =>
                    schema
                        ? model!.withStructuredOutput(schema, { method: "jsonMode", name: `extract_${row.nodeName}` }).invoke(messages, { signal: s })
                        : model!.invoke(messages, { signal: s }),
                );
                // 无 schema 的节点自己抠 JSON：抠失败也归 OUTPUT_PARSE，同样进有界重试
                const value = schema ? out : extractJson(out.content);
                // ★ 节点级校验器（搬运⑤）：形状过了再验"值↔上下文一致性"。
                //   抛错发生在重试回调内 → 报错原文进 feedback，模型带着出路重试（有界）。
                const validator = nodeValidatorOf(row.schemaKey);
                if (validator) {
                    const problems = (await validator(value, state)) ?? [];
                    if (problems.length > 0) {
                        throw new Error(`Failed to parse. STACK/CONTEXT 校验未过：${problems.join("；").slice(0, 400)}`);
                    }
                }
                return value;
            },
            { timeoutMs },
        );
        if (!res.ok) throw new StructuredOutputFailure(res.failure);
        return { [output]: res.value, llmCalls: 1 };
    };
}

export function createNodeFromRow(row: Node): GraphNode<any> {
    switch (row.nodeType) {
        case "code": {
            const fn = codeRegistry.get(row.codeKey || row.nodeName);
            // 把节点声明（含 systemPrompt/temperature 等）传给注册表函数：
            // code 节点可读 node.systemPrompt（用户在前端配置的提示词优先，代码常量兜底）
            const run = async (state: any) => await fn(state, row);
            if (row.output) {
                // 有 output：函数只产出这一个通道的值（state => value）
                return async (state: any) => ({ [row.output]: await run(state) });
            }
            // 无 output：函数直接返回整份 partial state（通道在 stateExtra 里声明）
            return run as GraphNode<any>;
        }
        case "human": return humanGate(row.systemPrompt || row.description);
        case "llm": return llmNode(row);
        default: throw new Error(`未知节点类型：${row.nodeType}`);
    }
}

// ---------- 动态 State：通道名 = 节点声明的 output（语义名），不是节点名 ----------
// LangGraph 约束：节点名不能与通道名重名（架构师老约定）——所以 output 列要填
// 与节点名不同的语义名（如节点 architectPlan 产出通道 plan）。

export function buildStateFromNodes(rows: Node[], extra?: Record<string, any>): any {
    const channels: Record<string, any> = {
        ...extra,
        llmCalls: Annotation<number>({ default: () => 0, reducer: (x: number, y: number) => x + y }),
        human: Annotation<any>({ default: () => null, reducer: (_: any, u: any) => u }),
        humanAnswer: Annotation<any>({ default: () => null, reducer: (_: any, u: any) => u }),
    };
    for (const row of rows) {
        // stateExtra 声明的复杂 reducer 通道优先：节点 output 同名时不得覆盖
        // （否则 messages/functions 这类"追加/清空"语义会被普通覆盖语义冲掉）
        if (row.output && !(row.output in channels)) {
            channels[row.output] = Annotation<any>({ default: () => null, reducer: (_: any, u: any) => u });
        }
    }
    return Annotation.Root(channels);
}

// ---------- ★ 拼接函数：节点声明 + 边声明 → 编译好的图 ----------

export interface StitchOptions {
    stateExtra?: Record<string, any>;   // 复杂 reducer 通道（如 messages 追加/清空语义）
}

export function stitch(rows: Node[], edges: Edge[], opts?: StitchOptions): any {
    const state = buildStateFromNodes(rows, opts?.stateExtra);
    const graph = new StateGraph(state);
    for (const row of rows) graph.addNode(row.nodeName, createNodeFromRow(row));
    for (const e of edges) {
        // DB 声明的节点名是 string；LangGraph 的 START 常量是字面量 "__start__"，
        // 动态拼接时类型收窄不到字面量，统一按 any 传给图 API（运行时语义不变）。
        const from = (e.fromNode === "__start__" ? START : e.fromNode) as any;
        switch (e.type) {
            case "conditional": {
                // to_nodes = JSON：{"cond":"条件key","true":"节点A","false":"节点B"}
                const spec = JSON.parse(e.toNodes) as { cond: string; true: string; false: string };
                const cond = condRegistry.get(spec.cond);
                graph.addConditionalEdges(from, (s: any) => {
                    const next = cond(s) ? spec.true : spec.false;
                    return next === "__end__" ? END : next;
                });
                break;
            }
            case "parallel": {
                // to_nodes = JSON 数组：["viewA","viewB"]（并行分支）
                const targets = JSON.parse(e.toNodes) as string[];
                for (const t of targets) graph.addEdge(from, (t === "__end__" ? END : t) as any);
                break;
            }
            case "direct":
            default: {
                // to_nodes = 单个节点名
                graph.addEdge(from, (e.toNodes === "__end__" ? END : e.toNodes) as any);
            }
        }
    }
    return graph.compile({ checkpointer: new MemorySaver() });
}

// 带交互的执行循环：图跑完 → 有 pending 问题 → 问用户 → 带答案续跑（上限防死循环）
// 阻塞发生在图外（questioner.ask），不在图节点内——图每轮 invoke 都正常返回
//
// ⚠️ 9/18：这个上限原来是写死的 3，而它同时管着**两种**交互：
//   ① 架构师确认门的 y/n（一次就完，用不到几轮）；
//   ② 新增的架构师澄清追问（LLM 逐轮提问，最多 3 问 + 1 轮收口 = 需要 4 轮）。
//   写死 3 会把第 3 问之后的重跑直接掐掉，模型永远等不到"问答结束"那一轮，
//   表现为"问了三句就卡住不再出方案"。所以改成可配常量，默认 6（比 3 问留足收口余量）。
const MAX_INTERACTION_TURNS = Number(process.env.CF_MAX_INTERACTION_TURNS ?? 6);

export async function runWithInteraction(
    graph: any,
    input: Record<string, any>,
    threadId: string,
    questioner: Questioner,
): Promise<any> {
    let state = await graph.invoke(input, { configurable: { thread_id: threadId } });
    let turns = 0;
    while (state?.human && turns < MAX_INTERACTION_TURNS) {
        console.log(`\n[交互] ${state.human.prompt}`);
        const answer = await questioner.ask(state.human);
        state = await graph.invoke({ humanAnswer: answer }, { configurable: { thread_id: threadId } });
        turns += 1;
    }
    if (state?.human) {
        // 撞上限还没结束：必须显式说出来。静默截断会让"模型忘了收口"看着像引擎卡死。
        console.warn(`[交互] 已达轮次上限（${MAX_INTERACTION_TURNS}），仍有未答问题未消化，直接放行：${state.human.prompt}`);
    }
    return state;
}
