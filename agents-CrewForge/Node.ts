// ============================================================
// Node.ts —— DB 层：节点/边声明读取（sys_agent_node / sys_agent_edge）
//
// 表结构需要补两样东西（缺它们，拼接函数就没原料）：
//   1. sys_agent_node 加列：node_type / schema_key / code_key / output
//   2. 新增 sys_agent_edge：from_node → type → to_nodes
//
// 迁移 SQL 见 backed-CrewForge/sql/migration_agent_graph.sql。
// ============================================================
import type { BaseMessage } from "@langchain/core/messages";
import type { Graph, GraphNode } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { type FunctionItem} from "./manager"
import { initModels } from "./models";
import { pool } from "./db";
import { javaBaseUrl } from "./settings";

enum NODE { 
    "START",
    "human",    ///和人沟通
    "llm",      ///调用大模型处理
    "assemblyLine",      ///流水线（队列）
    "router",    ///路由选择节点      
    "parallel",     ///并行节点
    "circulation",  ///循环节点
    "END"
};
const INITFUNCTIONS:Record<string,any> = {
    "START":initStart,
    "human":initHuman,
    "llm":initLLM,
    "assemblyLine":initAssemblyLine,
    "router":initRouter,
    "parallel":initParallel,
    "circulation":initCirculation,
    "END":initEnd
}


// 连接池统一在 db.ts（阶段 2 并池：原先本文件与 task.ts 各一池、参数还硬编码）

// 一行 sys_agent_node（节点声明，不是实现——实现由代码注册表提供）
// 注意：这里不继承 RowDataPacket——它是"声明"类型，普通对象字面量要能直接赋值
// （RowDataPacket 带 constructor.name 字面量约束，普通对象无法满足）。
// DB 查询行类型用下面的 NodeRow。
export interface Node {
    nodeName: string;
    nodeType: "llm" | "code" | "human";   // llm=调模型 / code=纯代码(注册表) / human=交互门
    description: string;
    systemPrompt: string;   // llm: 提示词；human: 问用户的问题文案
    temperature: number;
    tools: string;
    model: string;          // llm 用：传给 initModels 的 JSON（provider/model/thinking/...）
    schemaKey: string;      // llm 用：schemaRegistry 的 key（结构化输出）
    codeKey: string;        // code 用：codeRegistry 的 key
    output: string;         // llm 产出写到哪个 state 通道（缺省 = nodeName）
    timeoutMs?: number;     // llm 用：单次调用超时（毫秒），缺省走 llm.ts 的 DEFAULT_TIMEOUT_MS
}

// DB 查询行类型：Node + mysql2 行标记（仅供 pool.query 泛型用，不导出使用）
interface NodeRow extends Node, RowDataPacket {}

// 一行 sys_agent_edge（图怎么连）
// 三列约定：from_node → type → to_nodes（from/to 是 MySQL 保留字，故用 from_node/to_nodes）
//   type = "direct"：普通边，to_nodes = 单个节点名（如 "finish"）
//   type = "conditional"：条件边，to_nodes = JSON 字符串
//           {"cond":"human_answered","true":"finish","false":"__end__"}（cond 是 condRegistry 的 key）
//   type = "parallel"：并行分支，to_nodes = JSON 数组字符串 ["viewA","viewB"]
export interface Edge {
    agentId?: number;
    fromNode: string;       // 起点节点名；"__start__" 表示 START
    type: "direct" | "conditional" | "parallel";   // 连接方式
    toNodes: string;        // 下一批节点（string 存储，格式见上）
}

export async function getNodes(agentId: number): Promise<Node[]> {
    const [nodes] = await pool.query<NodeRow[]>(
        "select * from sys_agent_node where agent_id = ?",
        [agentId]
    );
    return nodes.map((n) => ({
        nodeName: n.node_name,
        nodeType: n.node_type ?? "llm",
        description: n.description ?? "",
        systemPrompt: n.system_prompt ?? n.description ?? "",
        temperature: n.temperature ?? 0.7,
        tools: n.tools ?? "",
        model: n.model ?? "{}",
        schemaKey: n.schema_key ?? "",
        codeKey: n.code_key ?? "",
        // output 保持原值（NULL=无 output 通道）：不能回退 node_name——LangGraph 节点名/通道名不得重名
        output: n.output ?? "",
        timeoutMs: n.timeout_ms ?? undefined,
    }));
}

export async function getEdges(agentId: number): Promise<Edge[]> {
    const [edges] = await pool.query(
        "select from_node, type, to_nodes from sys_agent_edge where agent_id = ? and deleted = 0",
        [agentId]
    );
    return (edges as any[]).map((e) => ({
        agentId,
        fromNode: e.from_node,
        type: e.type ?? "direct",
        toNodes: e.to_nodes,
    }));
}

/** 项目级节点读取：成员在项目内的节点副本（sys_project_agent_node，复制自池、项目内独立修改） */
export async function getProjectNodes(projectId: number, agentId: number): Promise<Node[]> {
    const [nodes] = await pool.query<NodeRow[]>(
        "select * from sys_project_agent_node where project_id = ? and agent_id = ? and deleted = 0 order by id asc",
        [projectId, agentId]
    );
    return nodes.map((n) => ({
        nodeName: n.node_name,
        nodeType: (n.node_type ?? "llm") as Node["nodeType"],
        description: n.description ?? "",
        systemPrompt: n.system_prompt ?? n.description ?? "",
        temperature: n.temperature ?? 0.7,
        tools: n.tools ?? "",
        model: n.model ?? "{}",
        schemaKey: n.schema_key ?? "",
        codeKey: n.code_key ?? "",
        // output 保持原值（NULL=无 output 通道）：不能回退 node_name——LangGraph 节点名/通道名不得重名
        output: n.output ?? "",
        timeoutMs: n.timeout_ms ?? undefined,
    }));
}

/** 项目成员列表（sys_project_agent JOIN sys_agent 带出角色） */
export async function getProjectAgents(projectId: number): Promise<{ agentId: number; name: string; role: string }[]> {
    const [rows] = await pool.query(
        `select pa.agent_id, sa.name, sa.role
         from sys_project_agent pa
         left join sys_agent sa on sa.id = pa.agent_id
         where pa.project_id = ? and pa.deleted = 0
         order by pa.id asc`,
        [projectId]
    );
    return (rows as any[]).map((r) => ({ agentId: r.agent_id, name: r.name ?? "", role: r.role ?? "" }));
}

/** 按节点名取 systemPrompt：用户在前端配置的节点 prompt 优先，空则回退内置默认 */
export function nodePrompt(nodes: Node[], nodeName: string, fallback: string): string {
    const hit = nodes.find((n) => n.nodeName === nodeName);
    const p = (hit?.systemPrompt ?? "").trim();
    return p || fallback;
}

// ============================================================
// 产出落库：PM/架构师 的运行产物写回 sys_project（与读取平行，直连 mysql2）
//   映射（实体列名）：
//     clarified_req     PM 每轮确认的功能清单（{features:[...]}）
//     dev_plan          PM 定稿的开发计划 JSON
//     business_modules  架构师业务模块（detailedPlan.modules）
//     tech_stack        架构师技术选型（stack）
// ============================================================

/** 通用 UPDATE sys_project：只更新给定列 + update_time */
export async function updateProjectField(projectId: number, fields: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(fields);
    if (!projectId || keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    await pool.query(
        `UPDATE sys_project SET ${sets}, update_time = NOW() WHERE id = ? AND deleted = 0`,
        [...keys.map((k) => fields[k]), projectId],
    );
}

/** PM 每轮确认功能后写 clarified_req（确认一个更新一次；features 为累积清单数组） */
export async function saveClarifiedReq(projectId: number, features: unknown[]): Promise<void> {
    await updateProjectField(projectId, { clarified_req: JSON.stringify({ features }) });
}

/** PM 定稿后写 dev_plan。
 *  ⚠️ 不再写 status=planning（阶段 3 live 修）：开工路径 Java 已先置 executing，
 *  对话在"定稿→拆分"窗口把状态改回 planning = 状态机倒退——窗口里棒一死（手动模式
 *  确认门可等人 30min），对账器只扫 executing 不再接管，项目永久孤儿。
 *  planning 语义留给网页 ArchitectView 手动保存；终端跑引擎由 saveArchitectOutput 置 executing 继续。 */
export async function saveDevPlan(projectId: number, plan: unknown): Promise<void> {
    await updateProjectField(projectId, { dev_plan: JSON.stringify(plan) });
}

/** 架构师每阶段拆分完写 business_modules + tech_stack + status=executing */
export async function saveArchitectOutput(projectId: number, modules: unknown, stack: unknown): Promise<void> {
    await updateProjectField(projectId, {
        business_modules: modules ? JSON.stringify(modules) : null,
        tech_stack: stack ? JSON.stringify(stack) : null,
        status: "executing",
    });
}

// ============================================================
// 代码落库：生成的文件同步写 sys_project_file（前端回显/项目树的数据源）
//   表：sys_project_file（project_id / file_path / file_content / file_type / user_modified）
//   写入时机：writeWorkspace 写盘后同步 upsert（Agent 产出，user_modified=0）
// ============================================================

/** 按扩展名推断 file_type（与后端 ProjectFile 的取值一致） */
export function inferFileType(filePath: string): string {
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    const map: Record<string, string> = {
        java: "java", vue: "vue", ts: "ts", js: "ts", yml: "yml", yaml: "yml",
        xml: "xml", sql: "sql", md: "md", json: "json", html: "html", css: "css",
        gitkeep: "other",
    };
    return map[ext] ?? "other";
}

/** upsert 项目文件：同 project_id+file_path 已存在则更新内容，否则插入（不依赖唯一索引，先查后写） */
export async function upsertProjectFile(projectId: number, filePath: string, content: string): Promise<void> {
    if (!projectId || !filePath) return;
    const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT id FROM sys_project_file WHERE project_id = ? AND file_path = ? AND deleted = 0 LIMIT 1",
        [projectId, filePath],
    );
    if (rows.length > 0 && rows[0]) {
        await pool.query(
            "UPDATE sys_project_file SET file_content = ?, file_type = ?, user_modified = 0, update_time = NOW() WHERE id = ?",
            [content, inferFileType(filePath), rows[0].id],
        );
    } else {
        await pool.query(
            `INSERT INTO sys_project_file (project_id, file_path, file_content, file_type, user_modified, create_time, update_time)
             VALUES (?, ?, ?, ?, 0, NOW(), NOW())`,
            [projectId, filePath, content, inferFileType(filePath)],
        );
    }
    // agent 修改 → 通知 Java 清缓存（查询侧每次写缓存，仅修改侧清；失败不阻塞）
    // A7 根治：基址走 sys_settings.java_base_url（读不到时 settings.ts 内藏 localhost 兜底）
    fetch(`${javaBaseUrl()}/api/projectfile/cache/clear/${projectId}`, { method: "POST" })
        .catch(() => { /* 后端未启动等场景忽略 */ });
}

/** 读取项目文件内容（从 sys_project_file），用于 agent 修改前查看旧内容 */
export async function readProjectFile(projectId: number, filePath: string): Promise<string | null> {
    if (!projectId || !filePath) return null;
    const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT file_content FROM sys_project_file WHERE project_id = ? AND file_path = ? AND deleted = 0 LIMIT 1",
        [projectId, filePath],
    );
    return rows.length > 0 ? (rows[0]!.file_content ?? null) : null;
}

/** 读取项目确认模式（sys_project.confirm_mode），用于判断是否弹出确认门 */
export async function getProjectConfirmMode(projectId: number): Promise<number> {
    if (!projectId) return 0;
    const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT confirm_mode FROM sys_project WHERE id = ? AND deleted = 0 LIMIT 1",
        [projectId],
    );
    if (!rows || rows.length === 0) return 0;
    return rows[0]!.confirm_mode ?? 0;
}

/** 读取 dev_plan（JSON.parse 结果，脏数据/未定稿返回 null）+ 当前 status —— 阶段 2 续跑判定：有现成 plan 就跳过 PM 对话直接开工 */
export async function getProjectPlan(projectId: number): Promise<{ plan: unknown | null; status: string | null }> {
    if (!projectId) return { plan: null, status: null };
    const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT dev_plan, status FROM sys_project WHERE id = ? AND deleted = 0 LIMIT 1",
        [projectId],
    );
    if (!rows || rows.length === 0) return { plan: null, status: null };
    const r = rows[0]!;
    // ⚠️ dev_plan 是 JSON 列：mysql2 驱动自动反序列化成对象。按 TEXT 习惯 String() 再 parse
    //   会得到 "[object Object]" 抛异常→伪装成"无 plan"，续跑永远回炉 PM 对话（阶段 2 live 逮到，F6 同坑三番）。
    let plan: unknown | null = null;
    try {
        const raw = r.dev_plan as unknown;
        if (raw != null) plan = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch { /* 脏 JSON 视同无 plan */ }
    return { plan, status: (r.status as string) ?? null };
}

/** 读取项目需求文本（sys_project.description + clarified_req 合并）——全绿灯首轮注入 PM 对话用（B2 需求注入） */
export async function getProjectRequirement(projectId: number): Promise<string> {
    if (!projectId) return "";
    const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT description, clarified_req FROM sys_project WHERE id = ? AND deleted = 0 LIMIT 1",
        [projectId],
    );
    if (!rows || rows.length === 0) return "";
    const r = rows[0]!;
    return [r.description, r.clarified_req].filter((x: string | null) => x && String(x).trim()).join("\n\n").trim();
}

export function initNode(nodeInformation: Node): GraphNode<any> {
    const type: string = nodeInformation.nodeType;
    const initFunction = INITFUNCTIONS[type];
    if (!initFunction) {
        throw new Error(`未知节点类型：${type}（已实现：${Object.keys(INITFUNCTIONS).join("、")}；router/parallel/circulation 等为预留未实现）`);
    }
    return initFunction(nodeInformation);
}

function initStart(){
    return async (state: any) => ({});
}

function parsePMResponse(response: BaseMessage): { newFunctions: FunctionItem[]; done: boolean } {
  const text = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
  return parsePMResponseText(text);
}

export function parsePMResponseText(text: string): { newFunctions: FunctionItem[]; done: boolean } {
  const newFunctions: FunctionItem[] = [];
  let done = false;
  let cursor = 0;

  while (cursor < text.length) {
    const start = text.indexOf("{", cursor);
    if (start < 0) break;

    let depth = 0;
    let end = -1;
    for (let index = start; index < text.length; index++) {
      if (text[index] === "{") depth++;
      else if (text[index] === "}") {
        depth--;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end < 0) break;

    try {
      const data = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(data.features)) newFunctions.push(...data.features);
      if (data.done === true) done = true;
    } catch {
      // 文字里的非 JSON 花括号不是协议内容，继续寻找下一个对象。
    }
    cursor = end + 1;
  }

  return { newFunctions, done };
}

function initHuman(info: Node): GraphNode<any> {
    const prompt = info.systemPrompt;
    return async (state: any) => {
        if (state.humanAnswer != null) {
            return { human: null, humanAnswer: null };
        }
        return { human: { questionId: randomUUID(), prompt, options: ["y", "n"] } };
    };
}
// ---------- 预留节点（未实现，为将来提高图自由度做铺垫） ----------
// 当前控制流已由"边"承担，不需要这些节点类型也能表达完整图：
//   路由    → 边 type="conditional" + condRegistry
//   并行    → 边 type="parallel"（JSON 数组多出边）
//   循环    → 一条边指回前节点 + 条件边退出
// 将来若要"前端拖一个显式控制节点"，再补这些实现（createNodeFromRow 加一行 case 即可）。
// ⚠️ 未实现前配置这些类型会走到 initNode 的抛错分支，不会静默透传。

// 预留：llm 节点（当前 llm 节点由 GraphFactory.llmNode 实现，DB 配 nodeType="llm" 即可）
function initLLM(nodeInformation: Node) {
    throw new Error(`节点类型 llm 由 GraphFactory 的 createNodeFromRow 处理，请配置 node_type="llm" + schema_key/output，不要走 initNode`);
}

// 预留：流水线节点（当前流水线是 BackendEngineer/FrontendEngineer 的队列工位，不在图内）
function initAssemblyLine(nodeInformation: Node) {
    throw new Error("节点类型 assemblyLine 为预留：当前流水线由开发类的队列工位实现，未接入图节点");
}

// 预留：路由节点（当前路由由边 type="conditional" + condRegistry 承担）
function initRouter(nodeInformation: Node) {
    throw new Error("节点类型 router 为预留：当前路由由边 type=conditional + condRegistry 承担");
}

// 预留：并行节点（当前并行由边 type="parallel" 多出边承担）
function initParallel(nodeInformation: Node) {
    throw new Error("节点类型 parallel 为预留：当前并行由边 type=parallel（JSON 数组多出边）承担");
}

// 预留：循环节点（当前循环由边指回前节点 + 条件边退出承担）
function initCirculation(nodeInformation: Node) {
    throw new Error("节点类型 circulation 为预留：当前循环由边指回前节点 + 条件边退出承担");
}

function initEnd() {
    return async (state: any) => ({});
}

