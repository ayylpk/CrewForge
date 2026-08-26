// ============================================================
// architect.ts —— 架构师（单例 "architect"）
//
//   完整逻辑移植自 _legacy-agents/architect.ts，结构参照 manager.ts：
//     phase_plan → 拆分图（业务分解 → 技术栈 → 确认门 → 基础架构 → 接口拆分 → 下发）
//     phase_done → 转告 PM 请求下一阶段
//
//   拆分图走 GraphFactory 的 stitch()：DB 存声明（DEFAULT_NODES/EDGES），
//   实现注册进 codeRegistry / schemaRegistry / condRegistry。
//   确认门用 human 交互（runWithInteraction + CliQuestioner；AUTO_CONFIRM=1 自动 y）。
//   接口拆分失败/被拒 → 声明 0 对并 final，阶段直接完成（不卡死）。
// ============================================================

import { z } from "zod";
import { SystemMessage } from "@langchain/core/messages";
import { Annotation } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { BaseAgent } from "./BaseAgent";
import { roles, type TransferStation } from "./Hub";
import { initModels } from "./models";
import { retryStructured } from "./llm";
import {
    stitch, runWithInteraction, CliQuestioner,
    codeRegistry, schemaRegistry, condRegistry,
    type StateNodeFn, type CondFn,
} from "./GraphFactory";
import { type Node, type Edge, saveArchitectOutput, readProjectFile, getProjectConfirmMode } from "./Node";
import { writeWorkspace, type Pair, type ExecTask, type Plan, type planItem } from "./common";
import { currentProjectId, projectDir } from "./runEnv";

// ---------- 模型 ----------

const ARCHITECT_MODEL_JSON = JSON.stringify({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    temperature: 0.3,
    thinking: false,
});

// ---------- 提示词（移植自 _legacy-agents/architect.ts） ----------

export const plan_prompt: string = `
# 角色
你是 CrewForge 项目的架构师-业务规划 Agent。你的输出是当前阶段的业务模块蓝图，供技术栈设计和接口拆分继续使用。

## 任务
1. 将本阶段的每个功能拆成一个业务模块，business 必须填写输入中的原始功能名。
2. description 描述角色、触发条件、主要步骤、状态变化和结果，不写实现代码。
3. dataNeeds 只列出实现该模块确实需要持久化或读取的数据，写实体和字段需求，不设计表结构。
4. points 拆成可执行的业务子步骤，覆盖正常流程和关键异常分支，供接口拆分使用。

## 边界
- 只处理输入中已确认的功能，不新增、不合并、不改变功能含义。
- 不做技术选型，不指定框架、数据库、表名或接口路径。
- 不把可选建议写成必做事项；信息不足时在 risks 中指出，不要猜测。
- 模块必须覆盖输入的全部功能，不能遗漏；一个功能对应一个模块。

## 输出
只输出合法 JSON，不要 Markdown、解释或额外字段：
{
  "summary": "一句话：本阶段做哪些业务",
  "modules": [
    {
      "name": "模块名",
      "business": "对应功能名",
      "description": "角色、触发条件、主要步骤、状态变化和结果",
      "dataNeeds": ["实体或字段需求"],
      "points": ["可执行的业务子步骤"]
    }
  ],
  "risks": ["业务实现风险"],
  "deliverables": ["交付物清单"]
}
`;

export const stack_prompt: string = `
# 角色
你是 CrewForge 项目的架构师-技术落地 Agent。你的输出是当前阶段唯一的技术基线，供基础架构和开发 Agent 使用。

## 任务
1. 只选择当前阶段实际需要的中间件，并说明每项用途；不要为了完整而堆叠技术。
2. 将 dataNeeds 落成可实现的表和字段，字段类型、必填性和业务含义必须明确，避免重复存储和无法验证的字段。
3. 为每个业务模块绑定服务端和客户端技术。backend 只写服务端框架、ORM、数据库访问等；frontend 只写前端框架、UI 和请求库等。
4. why 说明关键取舍，并指出会影响后续开发的风险。

## 约束
- 技术选择必须服务于输入中的业务模块和数据需求，不新增业务功能。
- moduleTech 必须覆盖每个输入模块，module 名必须原样复制。
- 表字段应能支撑输入中的功能和验收，不设计与当前阶段无关的表。
- 不输出接口路径、文件清单或代码；这些由后续 Agent 负责。

## 输出
只输出合法 JSON，不要 Markdown、解释或额外字段：
{
  "techniques": {
    "middleware": [{ "name": "技术名", "purpose": "用途" }],
    "database": { "type": "数据库类型", "why": "为什么选它" }
  },
  "tables": [
    { "name": "表名", "purpose": "服务哪个数据需求", "fields": [{ "name": "字段名", "type": "类型", "required": true, "remark": "业务含义" }] }
  ],
  "moduleTech": [{ "module": "模块名", "backend": "服务端技术", "frontend": "客户端技术" }],
  "why": "整体选型理由"
}
`;

export const base_prompt: string = `
# 角色
你是 CrewForge 项目的架构师-基础架构 Agent，负责把当前阶段需要的工程基础动作整理成可执行清单。

## 任务
根据技术栈、表结构和交付物清单：
1. actions 列出需要新建或补齐的脚手架、配置、目录和依赖。已有基础只列缺失项。
2. ddl 将输入表结构落成与目标数据库匹配的建表 SQL，包含必要的主键、约束和索引。

## 约束
- 只补基础设施，不新增业务功能，不设计接口，不写业务代码。
- actions 必须具体到后续开发可以执行；无法确认的前置条件写入动作描述，不要擅自选择。

## 输出
只输出合法 JSON，不要 Markdown、解释或额外字段：
{ "actions": ["基建动作"], "ddl": "建表 SQL" }
`;

/** bootstrap 提示词：把 basePlan（actions/ddl）变成真实的地基文件内容（脚手架/配置/DDL） */
export const bootstrap_prompt: string = `
# 角色
你是 CrewForge 项目的架构师-工程地基落地 Agent。输入是基础架构清单（actions + ddl），输出是可直接写盘的项目地基文件。

## 输入
1. actions：需要新建或补齐的脚手架、配置、目录和依赖动作（字符串列表，可能较长）
2. ddl：与目标数据库匹配的建表 SQL
3. techStack：技术选型（中间件/数据库/技术绑定），用于生成依赖与配置

## 任务
把 actions 和 ddl 转成**具体的文件**，每个文件包含完整可直接使用的 content：
- 依赖/脚手架动作 → 生成对应的构建文件（如 pom.xml、package.json 依赖段）
- 配置动作 → 生成对应的配置文件（如 application.yml、vite.config、.env.example）
- 目录动作 → 用空文件占位（content 留空字符串即可，如 src/main/java/.gitkeep）
- ddl → 生成 ddl.sql 文件，原样保留建表 SQL
- 无法确定内容的动作 → 跳过，不要编造

## 约束
- 只写项目地基文件（脚手架/配置/DDL/占位），绝不写业务代码（Controller/Service/页面组件由开发 Agent 负责）
- path 使用相对路径（如 pom.xml、src/main/resources/application.yml），不含 ../
- content 必须是完整可用的文件内容；占位文件 content 用空字符串
- 文件数量控制在合理范围（5-15 个），不要重复造轮子

## 输出
只输出合法 JSON，不要 Markdown、解释或额外字段：
{ "files": [ { "path": "pom.xml", "content": "文件完整内容" } ] }
`;

export const api_prompt: string = `
# 角色
你是 CrewForge 项目的架构师-接口设计 Agent。你的输出是原子的接口任务对，供后端和前端开发 Agent 直接执行。

## 任务
1. 根据每个模块的 points、dataNeeds 和技术绑定，拆出能独立实现和验收的接口。
2. 每个接口必须生成一对任务：一个后端任务和一个前端任务，顺序固定为后端在前、前端在后。
3. 接口粒度以一个完整业务动作或可独立验收的查询为单位；不要把同一动作拆成无意义的小接口，也不要遗漏必要的读写接口。
4. 后端任务写清 method、path、参数、返回和文件清单；前端任务写清页面、交互、调用接口和文件清单。

## 输入
业务模块（数据需求 + 实现要点）+ 技术绑定（每个模块用什么技术实现，backend/frontend 分开）

## 边界
- 只设计接口和页面形态，不写实现代码，不发明输入中没有的业务规则。
- module 必须原样使用输入里的模块名，不能自创或改写。
- 参数 type 只能使用 string、number、boolean、array、object；required 必须反映业务必填性。
- 前端 api 必须与同一任务对的后端 method 和 path 完全一致，字段名也要一致。
- files 是开发 Agent 唯一允许产出的文件清单：按技术栈列出本任务需要的全部文件，不遗漏、不填无关文件。
- 每个任务的验收标准必须来自对应模块的业务要求，不新增无法追溯的验收条件。

## 输出
只输出合法 JSON，不要 Markdown、解释或额外字段。tasks 是二维数组，每项固定为 [后端任务, 前端任务]：
{
  "tasks": [
    [
      { "method": "POST", "path": "/api/tasks", "module": "模块名", "purpose": "接口职责", "files": ["src/routes/tasks.ts"], "parameters": [{ "name": "title", "type": "string", "required": true, "description": "任务标题" }], "response": "返回说明" },
      { "module": "模块名", "page": "页面/组件名", "files": ["src/pages/TasksForm.vue"], "interactions": "页面交互（表单/列表/刷新等）", "api": "POST /api/tasks" }
    ]
  ]
}
`;

// ---------- 结构化 schema（schemaRegistry，DB 的 schema_key 引用） ----------

export const detailedPlanSchema = z.object({
    summary: z.string(),
    modules: z.array(z.object({
        name: z.string(),
        business: z.string(),
        description: z.string(),
        dataNeeds: z.array(z.string()),
        points: z.array(z.string()),
    })),
    risks: z.array(z.string()),
    deliverables: z.array(z.string()),
});

export const stackSchema = z.object({
    techniques: z.object({
        middleware: z.array(z.object({ name: z.string(), purpose: z.string() })),
        database: z.object({ type: z.string(), why: z.string() }),
    }),
    tables: z.array(z.object({
        name: z.string(),
        purpose: z.string(),
        fields: z.array(z.object({ name: z.string(), type: z.string(), required: z.boolean(), remark: z.string() })),
    })),
    moduleTech: z.array(z.object({ module: z.string(), backend: z.string(), frontend: z.string() })),
    why: z.string(),
});

export const baseSchema = z.object({
    actions: z.array(z.string()),
    ddl: z.string(),
});

// 工程地基文件清单：bootstrap 节点把 basePlan 转成可写盘的文件
export const bootstrapSchema = z.object({
    files: z.array(z.object({
        path: z.string(),
        content: z.string(),
    })),
});

// 接口拆分：二维数组，每对固定 [后端任务, 前端任务]
export const resolutionSchema = z.object({
    tasks: z.array(z.tuple([
        z.object({
            method: z.string(),
            path: z.string(),
            module: z.string(),
            purpose: z.string(),
            files: z.array(z.string()),
            parameters: z.array(z.object({
                name: z.string(),
                type: z.string(),
                required: z.boolean(),
                description: z.string(),
            })),
            response: z.string(),
        }),
        z.object({
            module: z.string(),
            page: z.string(),
            files: z.array(z.string()),
            interactions: z.string(),
            api: z.string(),
        }),
    ])),
});

type ResolutionBack = z.infer<typeof resolutionSchema>["tasks"][number][0];
type ResolutionFront = z.infer<typeof resolutionSchema>["tasks"][number][1];

// ---------- 节点实现（codeRegistry，DB 的 code_key 引用） ----------

/** 工程地基落地：读 basePlan（actions/ddl）→ LLM 转文件清单 → 逐个写盘（沙箱校验） */
const bootstrapNode: StateNodeFn = async (state, node) => {
    const basePlan = state?.basePlan;
    // 没有地基计划（确认门被拒等）→ 跳过，不卡流水线
    if (!basePlan || !Array.isArray(basePlan.actions)) {
        console.log("[architect] bootstrap：无 basePlan，跳过地基落地");
        return {};
    }
    const prompt = node?.systemPrompt?.trim() || bootstrap_prompt;
    const stack = state?.stack ?? {};
    // 读取当前项目已有的地基文件，供 LLM 参考（追加修改时保留已有内容）
    let existingFilesPrompt = "";
    try {
        const pid = currentProjectId();
        if (pid) {
            const commonPaths = ["pom.xml", "package.json", "application.yml", "application.properties",
                "vite.config.ts", "tsconfig.json", ".env.example", "docker-compose.yml"];
            const existing: string[] = [];
            for (const p of commonPaths) {
                const content = await readProjectFile(pid, p);
                if (content) existing.push(`--- ${p} ---\n${content.slice(0, 20000)}`);
            }
            if (existing.length > 0) {
                existingFilesPrompt = `\n\n## 项目已有的文件（在此之上修改/追加，保留所有已有配置）\n${existing.join("\n")}`;
            }
        }
    } catch { /* 静默 */ }
    try {
        const parsed = await retryStructured<{ files: { path: string; content: string }[] }>(
            "工程地基落地",
            async (feedback, sig) => {
                const model = initModels(ARCHITECT_MODEL_JSON);
                const result = await model
                    .withStructuredOutput(bootstrapSchema, { method: "jsonMode", name: "extract_bootstrap" })
                    .invoke([
                        new SystemMessage(
                            prompt +
                            `\n\n## 基础架构动作（basePlan）\n${JSON.stringify(basePlan, null, 2)}` +
                            `\n\n## 技术选型（stack）\n${JSON.stringify(stack, null, 2)}` +
                            existingFilesPrompt +
                            feedback,
                        ),
                    ], { signal: sig });
                return result as { files: { path: string; content: string }[] };
            },
            // 地基是流水线输出量最大的节点（5-15 个完整文件内容），180s 默认超时不够，单独放宽到 300s
            { timeoutMs: 300_000 },
        );
        const files = parsed?.files ?? [];
        for (const f of files) {
            if (!f?.path) continue;
            try {
                writeWorkspace(f.path, f.content ?? "");
                console.log(`[architect] 地基文件已写入：${f.path}`);
            } catch (e) {
                console.warn(`[architect] 地基文件写入失败（跳过）：${f.path} - ${(e as Error).message}`);
            }
        }
        console.log(`[architect] 地基落地完成：${files.length} 个文件`);

        // 状态落盘（含地基就绪标记）：阶段 2+ 的 runPhaseSplit 读回 → 条件边短路跳过技术栈/确认门/地基
        const pid = currentProjectId();
        if (pid != null) {
            try {
                const stateFile = projectDir(pid) + "/.architect-state.json";
                fs.mkdirSync(projectDir(pid), { recursive: true });
                fs.writeFileSync(stateFile, JSON.stringify(
                    { bootstrapDone: true, stack: state?.stack ?? null, basePlan: state?.basePlan ?? null },
                    null, 2,
                ));
                console.log("[architect] 架构状态已落盘：.architect-state.json（后续阶段将短路复用）");
            } catch (e) {
                console.warn("[architect] 架构状态落盘失败:", (e as Error).message);
            }
        }
        return { bootstrapFiles: files, bootstrapDone: true };
    } catch (e) {
        // LLM 失败不阻塞流水线：记录并继续（地基缺失，开发仍按接口任务写代码）
        console.warn("[architect] 工程地基落地失败（跳过）:", (e as Error).message);
        return {};
    }
};

/** 确认门：human 交互（y/n），把答案保留进 confirmAnswer 供条件边判断（humanGate 会清掉 humanAnswer）
 *  确认模式控制：0-全绿灯(自动) / 1-混合(自动) / 2-手动(弹出确认) */
const confirmNode: StateNodeFn = async (state, node) => {
    if (state.humanAnswer != null) {
        return { human: null, confirmAnswer: state.humanAnswer, humanAnswer: null };
    }
    const mode = state.confirmMode ?? 0;
    // 全绿灯(0) 或 混合(1)：架构师确认门自动跳过
    if (mode === 0 || mode === 1) {
        return { human: null, confirmAnswer: "y", humanAnswer: null };
    }
    return { human: { questionId: randomUUID(), prompt: node?.systemPrompt?.trim() || "技术方案如上，确认开工？(y / n)", options: ["y", "n"] } };
};

/** 接口拆分 + 任务构建 + 下发（station 副作用）。返回 exeTasks。 */
function makeDispatchNode(station: TransferStation): StateNodeFn {
    return async (state) => {
        const plan: Plan = state.plan;
        const detailed: any = state.detailedPlan;
        const stack: any = state.stack;
        if (!plan || !detailed || !stack) throw new Error("接口拆分缺少前置输入（plan/detailedPlan/stack）");

        const phaseNo = plan.phases[0]?.phase ?? 1;

        // 1. LLM 接口拆分（api_prompt + 业务模块 + 技术绑定；重试 ≤3 带反馈）
        const modulesContent = detailed.modules
            .map((m: any) => `${m.name}（对应功能：${m.business}）\n   数据需求：${(m.dataNeeds ?? []).join("、")}\n   要点：${(m.points ?? []).join("；")}`)
            .join("\n");
        const techContent = (stack.moduleTech ?? [])
            .map((mt: any) => `${mt.module} → 后端：${mt.backend}｜前端：${mt.frontend}`)
            .join("\n");

        const parsed = await retryStructured<{ tasks: [ResolutionBack, ResolutionFront][] }>(
            "接口拆分",
            async (feedback, sig) => {
                const model = initModels(ARCHITECT_MODEL_JSON);
                const result = await model
                    .withStructuredOutput(resolutionSchema, { method: "jsonMode", name: "extract_resolution" })
                    .invoke([new SystemMessage(api_prompt + `\n\n## 业务模块（阶段${detailed.phase}）\n${modulesContent}\n\n## 技术绑定\n${techContent}` + feedback)], { signal: sig });
                return result as { tasks: [ResolutionBack, ResolutionFront][] };
            },
        );
        if (!parsed || parsed.tasks.length === 0) throw new Error("接口拆分返回空任务（tasks 为空数组）");

        // 2. 机械构建 ExecTasks：id 顺序生成；验收标准从 Plan.features 按模块 business 抄（验收契约不发明）
        const middlewareContent = (stack.techniques?.middleware ?? []).map((m: any) => `${m.name}（${m.purpose}）`).join("、");
        const dbContent = `${stack.techniques?.database?.type ?? ""}（${stack.techniques?.database?.why ?? ""}）`;

        const tasks: ExecTask[] = parsed.tasks.flatMap((pair, i) => {
            const [back, front] = pair;
            const mod = detailed.modules.find((m: any) => m.name === back.module)
                ?? detailed.modules.find((m: any) => back.module.includes(m.name) || m.name.includes(back.module));
            const acceptance = plan.features.find((f: any) => f.name === mod?.business)?.acceptance ?? "功能可正常使用";
            const mtech = (stack.moduleTech ?? []).find((mt: any) => mt.module === back.module)
                ?? (stack.moduleTech ?? []).find((mt: any) => back.module.includes(mt.module) || mt.module.includes(back.module));
            const backendTech = mtech?.backend ?? "";
            const frontendTech = mtech?.frontend ?? "";

            const backendTask: ExecTask = {
                id: `T${i + 1}`,
                layer: "backend",
                method: back.method,
                path: back.path,
                files: back.files,
                title: `${back.method} ${back.path}：${back.purpose}`,
                description: `模块：${back.module}\n业务：${mod?.business}\n技术：${backendTech}\n中间件：${middlewareContent}\n数据库：${dbContent}\n入参：${back.parameters.map(p => `${p.name}(${p.type}${p.required ? "" : "，可选"})`).join("、")}\n返回：${back.response}`,
                parameters: back.parameters,
                acceptance,
            };

            // 自包含铁律：后端契约机械抄进前端描述（字段名/格式照抄，前端不探索）
            const contract = `\n\n【后端契约（前端必须遵守：字段名/格式/枚举值照抄，不得改名）】\n接口：${back.method} ${back.path}\n入参：${back.parameters.map(p => `${p.name}(${p.type}${p.required ? "" : "，可选"})：${p.description}`).join("、")}\n返回：${back.response}`;
            const frontendTask: ExecTask = {
                id: `T${i + 1}-F`,
                layer: "frontend",
                method: "",
                path: "",
                files: front.files,
                title: `${front.page}：${front.interactions}`,
                description: `模块：${front.module}\n业务：${mod?.business}\n技术：${frontendTech}\n页面：${front.page}\n交互：${front.interactions}\n调用接口：${front.api}` + contract,
                parameters: [],
                acceptance,
            };

            return [backendTask, frontendTask];
        });

        // 3. 副作用：按层分流下发开发 + 声明给维护（final）+ 通知合并器清配对缓存
        for (const t of tasks) {
            const role = t.layer === "backend" ? roles.backendEngineer : roles.frontendEngineer;
            const target = station.pickLeastBusy(role);
            if (!target) { console.log(`提示：没有 ${t.layer} 开发注册，任务 ${t.id} 下发失败`); continue; }
            station.sendMessage("architect", target, JSON.stringify({ type: "task", task: t }));
            console.log(`[architect] 发送到 ${target}：下发任务 ${t.id}（${t.title}）`);
        }
        const pairIds = [...new Set(tasks.map(t => (t.id.endsWith("-F") ? t.id.slice(0, -2) : t.id)))];
        station.sendMessage("architect", "maintainer", JSON.stringify({ type: "tasks_declared", phase: phaseNo, pairIds, final: true }));
        console.log(`[architect] 声明阶段 ${phaseNo} 任务 ${pairIds.length} 对（final）`);
        station.sendMessage("architect", "merger", JSON.stringify({ type: "phase_reset", phase: phaseNo }));
        console.log(`[architect] 通知合并器：阶段 ${phaseNo} 配对缓存重置`);

        return { exeTasks: tasks, llmCalls: 1 };
    };
}

// ---------- 条件（condRegistry，条件边的 cond 引用） ----------

/** 确认门：回答 y → 去基础架构；n / 未答 → 结束（本阶段跳过，runPhaseSplit 声明 0 对） */
const confirmYes: CondFn = (state) => String(state.confirmAnswer ?? "").trim().toLowerCase().startsWith("y");

// ---------- 默认声明（模板可直接 new Architect(station)；生产用 DB 声明 + fromDb） ----------

export const DEFAULT_NODES: Node[] = [
    {
        nodeName: "architectPlan",
        nodeType: "llm",
        description: "业务分解：功能 → 业务模块蓝图",
        systemPrompt: plan_prompt,
        temperature: 0.3,
        tools: "",
        model: ARCHITECT_MODEL_JSON,
        schemaKey: "architect_detailed_plan",
        codeKey: "",
        output: "detailedPlan",
    },
    {
        nodeName: "architectStack",
        nodeType: "llm",
        description: "技术栈：技术基线",
        systemPrompt: stack_prompt,
        temperature: 0.3,
        tools: "",
        model: ARCHITECT_MODEL_JSON,
        schemaKey: "architect_stack",
        codeKey: "",
        output: "stack",
    },
    {
        nodeName: "confirmGate",
        nodeType: "code",
        description: "确认门：y/n 开工确认",
        systemPrompt: "技术方案如上，确认开工？(y / n)",
        temperature: 0.3,
        tools: "",
        model: ARCHITECT_MODEL_JSON,
        schemaKey: "",
        codeKey: "architect_confirm",
        output: "",
    },
    {
        nodeName: "base",
        nodeType: "llm",
        description: "基础架构：基建动作 + DDL",
        systemPrompt: base_prompt,
        temperature: 0.3,
        tools: "",
        model: ARCHITECT_MODEL_JSON,
        schemaKey: "architect_base",
        codeKey: "",
        output: "basePlan",
    },
    {
        nodeName: "bootstrap",
        nodeType: "code",
        description: "工程地基落地：basePlan → 文件清单 → 写盘",
        systemPrompt: bootstrap_prompt,
        temperature: 0.3,
        tools: "",
        model: ARCHITECT_MODEL_JSON,
        schemaKey: "",
        codeKey: "architect_bootstrap",
        output: "",
    },
    {
        nodeName: "dispatch",
        nodeType: "code",
        description: "接口拆分 + 任务构建 + 下发",
        systemPrompt: api_prompt,
        temperature: 0.3,
        tools: "",
        model: ARCHITECT_MODEL_JSON,
        schemaKey: "architect_resolution",
        codeKey: "architect_dispatch",
        output: "",
    },
];

export const DEFAULT_EDGES: Edge[] = [
    { fromNode: "__start__", type: "direct", toNodes: "architectPlan" },
    // 地基已就绪（阶段 2+）：跳过 architectStack/confirmGate/base/bootstrap，直接拆任务
    //（stack/basePlan 由 runPhaseSplit 从 .architect-state.json 读回注入；bootstrapDone 置 true 走此短路）
    { fromNode: "architectPlan", type: "conditional", toNodes: JSON.stringify({ cond: "architect_bootstrap_done", true: "dispatch", false: "architectStack" }) },
    { fromNode: "architectStack", type: "direct", toNodes: "confirmGate" },
    { fromNode: "confirmGate", type: "conditional", toNodes: JSON.stringify({ cond: "architect_confirm_yes", true: "base", false: "__end__" }) },
    { fromNode: "base", type: "direct", toNodes: "bootstrap" },
    { fromNode: "bootstrap", type: "direct", toNodes: "dispatch" },
    { fromNode: "dispatch", type: "direct", toNodes: "__end__" },
];

// ============================================================
// Architect —— 架构师（固定类，消息驱动 + 拆分图）
// ============================================================

export class Architect extends BaseAgent {
    private graph: any;

    constructor(station: TransferStation, nodes: Node[] = DEFAULT_NODES, edges: Edge[] = DEFAULT_EDGES) {
        super("architect", roles.architect, station);
        this.build(nodes, edges);

        // phase_plan → 拆分当前阶段；phase_done → 转告 PM 请求下一阶段
        this.on("phase_plan", { fromNames: ["manager"] }, ({ data }) => {
            void this.runPhaseSplit(data.plan as Plan, data.phase as planItem, data.projectId as number | undefined);
        });
        // 测试 3 次未过 → 回炉：重设计该接口任务并重新下发
        this.on("task_rejected", { fromRoles: [roles.testEngineer] }, ({ data }) => {
            void this.redesignTask(data.pair as Pair, data.issues as string[], data.phase as number);
        });
        this.on("phase_done", { fromNames: ["maintainer"] }, ({ data }) => {
            // 3 次兜底汇总：打印放弃清单（哪个接口没做出来 + 原因），不再静默
            if (Array.isArray(data.failed) && data.failed.length > 0) {
                console.log(`[architect] 阶段 ${data.phase} 放弃 ${data.failed.length} 个任务：`);
                data.failed.forEach((f: any) => {
                    const task = f.task ?? {};
                    console.log(`   - ${task.method || ""} ${task.path || f.pairId}（尝试 ${f.attempts ?? 3} 次）`);
                    (f.issues ?? []).forEach((i: string) => console.log(`       原因：${i}`));
                });
            }
            this.send("manager", { type: "phase_request", phase: data.phase });
            console.log(`[architect] 发送到 PM：请求下一阶段（阶段 ${data.phase} 已完成）`);
        });
    }

    /** 注册实现（schema/code/cond）→ stitch() 拼接编译 → this.graph */
    private build(nodes: Node[], edges: Edge[]): void {
        schemaRegistry.register("architect_detailed_plan", detailedPlanSchema);
        schemaRegistry.register("architect_stack", stackSchema);
        schemaRegistry.register("architect_base", baseSchema);
        schemaRegistry.register("architect_bootstrap", bootstrapSchema);
        schemaRegistry.register("architect_resolution", resolutionSchema);
        codeRegistry.register("architect_confirm", confirmNode);
        codeRegistry.register("architect_bootstrap", bootstrapNode);
        codeRegistry.register("architect_dispatch", makeDispatchNode(this.station));
        condRegistry.register("architect_confirm_yes", confirmYes);
        condRegistry.register("architect_bootstrap_done", (s: any) => s.bootstrapDone === true);

        console.log(`[architect] 拼接编译拆分图：${nodes.map(n => n.nodeName).join(" → ")}`);
        this.graph = stitch(nodes, edges, {
            stateExtra: {
                plan: Annotation<any>({ default: () => null, reducer: (_: any, u: any) => u }),
                confirmAnswer: Annotation<any>({ default: () => null, reducer: (_: any, u: any) => u }),
                exeTasks: Annotation<any[]>({ default: () => [], reducer: (_: any[], u: any[]) => u }),
                confirmMode: Annotation<number>({ default: () => 0, reducer: (_: number, u: number) => u }),
                bootstrapDone: Annotation<boolean>({ default: () => false, reducer: (_: boolean, u: boolean) => u }),
            },
        });
    }

    /** 拆分一个阶段：跑图（含确认门交互）→ 有任务已由 dispatch 下发；无任务则声明 0 对，阶段直接完成 */
    private async runPhaseSplit(plan: Plan, phase: planItem, projectId?: number): Promise<void> {
        console.log(`[architect] 拆分阶段 ${phase.phase}「${phase.name}」`);
        const planForPhase: Plan = {
            ...plan,
            features: plan.features.filter(f => phase.features.includes(f.name)),
            phases: [phase],
        };
        // 读取项目确认模式，控制确认门是否弹出
        let confirmMode = 0;
        if (projectId) {
            try { confirmMode = await getProjectConfirmMode(projectId); } catch { /* 默认 0 */ }
        }
        // 阶段 2+：地基已就绪 → 读回 stack/basePlan 并置 bootstrapDone → 条件边短路（见 DEFAULT_EDGES）
        const extraInput: any = { plan: planForPhase, confirmMode };
        const pid = currentProjectId();
        if (pid != null) {
            try {
                const stateFile = projectDir(pid) + "/.architect-state.json";
                if (fs.existsSync(stateFile)) {
                    const saved = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
                    if (saved?.bootstrapDone) {
                        extraInput.stack = saved.stack ?? null;
                        extraInput.basePlan = saved.basePlan ?? null;
                        extraInput.bootstrapDone = true;
                        console.log(`[architect] 复用已有架构状态：阶段 ${phase.phase} 跳过技术栈/确认门/地基，直接拆分任务`);
                    }
                }
            } catch { /* 读回失败走全图（退化为老行为，不阻塞） */ }
        }
        const state = await runWithInteraction(this.graph, extraInput, `architect-phase-${phase.phase}`, new CliQuestioner());
        // 落库：业务模块(detailedPlan) + 技术选型(stack) + status=executing
        if (projectId) {
            try {
                await saveArchitectOutput(projectId, state?.detailedPlan ?? null, state?.stack ?? null);
            } catch (e) {
                console.warn("[architect] 产出落库失败:", (e as Error).message);
            }
        }
        const tasks: ExecTask[] = state?.exeTasks ?? [];
        if (tasks.length > 0) {
            console.log(`[architect] 阶段 ${phase.phase} 拆出 ${tasks.length} 个任务并下发`);
        } else {
            // 方案被拒 / 拆分失败 → 声明 0 对并 final，维护据此直接完成本阶段（不卡死流水线）
            console.log(`[architect] 阶段 ${phase.phase} 无任务（被拒或拆分失败），声明 0 对完成`);
            this.send("maintainer", { type: "tasks_declared", phase: phase.phase, pairIds: [], final: true });
        }
    }

    /** 测试 3 次未过 → 回炉重设计：带问题重新拆分该接口（id 沿用原 pairId 保证计数连续）→ 重新下发 */
    private async redesignTask(pair: Pair, issues: string[], phase: number): Promise<void> {
        const back = pair.back;
        const front = pair.front;
        console.log(`[architect] 收到测试回炉：${back.id}（${back.method} ${back.path}），重新拆分该接口`);
        const prompt = api_prompt +
            `\n\n## 上一版后端任务（契约）\n${JSON.stringify(back, null, 2)}` +
            (front ? `\n\n## 上一版前端任务\n${JSON.stringify(front, null, 2)}` : "") +
            `\n\n## 测试判定问题（必须解决，否则同样会被拒）\n${issues.map((s, i) => `${i + 1}. ${s}`).join("\n")}` +
            `\n\n## 要求\n只重新设计这一个接口（${back.method} ${back.path}）为前后端任务对，修正契约中的问题（method/path/参数/返回/文件清单/前后端一致性），不要新增其他接口。`;
        try {
            const parsed = await retryStructured<{ tasks: [ResolutionBack, ResolutionFront][] }>(
                "接口重设计",
                async (feedback, sig) => {
                    const model = initModels(ARCHITECT_MODEL_JSON);
                    const result = await model
                        .withStructuredOutput(resolutionSchema, { method: "jsonMode", name: "extract_resolution" })
                        .invoke([new SystemMessage(prompt + feedback)], { signal: sig });
                    return result as { tasks: [ResolutionBack, ResolutionFront][] };
                },
            );
            const p0 = parsed?.tasks?.[0];
            if (!p0) throw new Error("重设计返回空任务");
            const [nb, nf] = p0;
            const id = back.id;   // ★ 沿用原 pairId，保证测试计数（阶段:pairId）连续到第 6 次

            // 后端任务：保留原 id/验收，用新契约覆盖 method/path/files/parameters/描述
            const newBack: ExecTask = {
                ...back,
                id,
                method: nb.method,
                path: nb.path,
                files: nb.files,
                title: `${nb.method} ${nb.path}：${nb.purpose}`,
                description: `【架构师重设计】原契约问题已修正。\n${back.description}\n修正要点：${nb.purpose}`,
                parameters: nb.parameters,
            };
            const bTarget = this.station.pickLeastBusy(roles.backendEngineer);
            if (bTarget) {
                this.station.sendMessage("architect", bTarget, JSON.stringify({ type: "task", task: newBack }));
                console.log(`[architect] 重设计后下发后端：${id}（${nb.method} ${nb.path}）`);
            }

            if (front && nf) {
                const newFront: ExecTask = {
                    ...front,
                    id: `${id}-F`,
                    files: nf.files,
                    title: `${nf.page}：${nf.interactions}`,
                    description: `【架构师重设计】原契约问题已修正。\n${front.description}\n修正要点：${nf.interactions} 调用 ${nf.api}`,
                    parameters: [],
                };
                const fTarget = this.station.pickLeastBusy(roles.frontendEngineer);
                if (fTarget) {
                    this.station.sendMessage("architect", fTarget, JSON.stringify({ type: "task", task: newFront }));
                    console.log(`[architect] 重设计后下发前端：${id}-F（${nf.page}）`);
                }
            }

            // 通知合并器：清该对的配对/交付缓存（防旧版前端配新版后端）
            this.station.sendMessage("architect", "merger", JSON.stringify({ type: "phase_reset", phase, pairId: id }));
            console.log(`[architect] 重设计完成，任务 ${id} 重新进入流水线`);
        } catch (e) {
            // 重设计失败 → 直接放弃上报（避免无限循环），不卡流水线
            console.warn("[architect] 接口重设计失败，放弃该任务:", (e as Error).message);
            this.send("maintainer", {
                type: "task_failed", phase, pairId: back.id,
                issues: issues ?? [], task: { id: back.id, method: back.method, path: back.path }, attempts: 6,
            });
            this.send("merger", { type: "task_failed", pairId: back.id });
        }
    }
}
