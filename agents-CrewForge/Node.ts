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
import mysql, { type RowDataPacket } from "mysql2/promise";
import { type FunctionItem} from "./manager"
import { initModels } from "./models";

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


const pool = mysql.createPool({
    host: "localhost",
    user: "root",
    password: "xxxxxx",
    database: "crewforge",
})

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

/** PM 定稿后写 dev_plan + status=planning */
export async function saveDevPlan(projectId: number, plan: unknown): Promise<void> {
    await updateProjectField(projectId, { dev_plan: JSON.stringify(plan), status: "planning" });
}

/** 架构师每阶段拆分完写 business_modules + tech_stack + status=executing */
export async function saveArchitectOutput(projectId: number, modules: unknown, stack: unknown): Promise<void> {
    await updateProjectField(projectId, {
        business_modules: modules ? JSON.stringify(modules) : null,
        tech_stack: stack ? JSON.stringify(stack) : null,
        status: "executing",
    });
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

/*
-- 迁移 SQL 见 backed-CrewForge/sql/migration_agent_graph.sql：
ALTER TABLE sys_agent_node
  ADD COLUMN node_type VARCHAR(16) NOT NULL DEFAULT 'llm',
  ADD COLUMN schema_key VARCHAR(64) NULL,
  ADD COLUMN code_key VARCHAR(64) NULL,
  ADD COLUMN output VARCHAR(64) NULL,
  ADD COLUMN timeout_ms INT NULL;

CREATE TABLE sys_agent_edge (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  agent_id BIGINT NOT NULL,
  from_node VARCHAR(64) NOT NULL,
  type VARCHAR(16) NOT NULL DEFAULT 'direct',
  to_nodes VARCHAR(255) NOT NULL,
  create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted TINYINT NOT NULL DEFAULT 0,
  INDEX idx_agent_id (agent_id)
) COMMENT 'agent 图连接声明';
*/
