// ============================================================
// live-llm-smoke.ts —— 真实 LLM 连通性冒烟（阶段 6 的门槛前置检查）
//
// 目的：只验证三件事，不跑真实开发任务——
//   ① 端点/token/模型名 三件套可用（凭证读自 .env）；
//   ② 模型按当前协议给出决策（9/14 起缺省 = 原生 tool_use；
//      要验旧文本协议就设 DEVELOPER_LLM_NATIVE_TOOLS=0）；
//   ③ coerceDecision 能消化模型返回。
//
// ⚠️ 环境变量优先级：本机 shell 里可能继承着 Claude Code 自己的
//   ANTHROPIC_BASE_URL（指向另一个中转站）。Bun 不会覆盖**已存在**的
//   process.env，所以直接用 process.env 会拿到错误端点（实测 404
//   model_not_found）。本文件在读 .env 时**强制覆盖** process.env，
//   保证"以仓库 .env 为准"，与 shell 里有什么无关。
//
// 跑法：cd agents-CrewForge && bun run developerAgent/live-llm-smoke.ts
// 退出码：0=全绿可进实弹；1=任一探针失败，先修配置再谈测试。
// ============================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { coerceDecision } from "./graph";
import { createRealLlm } from "./realLlm";
import { loadDotEnv, envFilePath } from "./dotenv";
import { createDeveloperToolRegistry } from "./tools/registry";

// 以仓库 .env 为准（覆盖 shell 继承的 CC 环境变量）
const loaded = loadDotEnv();
if (loaded < 0) console.log(`  ⚠ 读不到 ${envFilePath()}，回退到 shell 环境变量`);

const system = readFileSync(join(import.meta.dir, "prompts", "system.md"), "utf8");
const tools = createDeveloperToolRegistry().describe();

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string) {
    if (cond) { pass++; console.log(`  ✔ ${label}`); }
    else { fail++; console.log(`  ✘ ${label}`); }
}

const llm = createRealLlm({
    // 每次调用的观测：延迟 + token 用量，肉眼确认计费量级正常。
    // 9/15 批 C：额外打 attempts/escalated/缓存命中——重试与升档都是**内部**多发，
    // 不打出来就完全看不见（账面上仍是一步）。
    onCall: (i) => console.log(
        `  [call#${i.seq}] ${i.latencyMs}ms in=${i.inputTokens} out=${i.outputTokens} stop=${i.stopReason}`
        + ` attempts=${i.attempts}${i.escalated ? "(升档)" : ""}`
        + ` cache=${i.cacheReadTokens}/${i.cacheCreationTokens}`),
});

console.log(`model=${llm.id}`);

// ---------- 探针 1：done 决策（协议服从性底线） ----------
console.log("\n[1] done 探针：期望 {kind:'done'}");
const d1 = await llm.next({
    system, task: "这是一次连通性检查，没有任何要做的开发工作。请直接给出 done 决策。",
    skill: null, history: [], tools, budget: { used: 0, total: 100 },
});
const c1 = coerceDecision(d1);
ok(c1 !== null, "决策可解析");
ok(c1?.kind === "done", `kind=done（实际=${c1?.kind ?? "null"}）`);
if (typeof d1 !== "object") console.log(`  （原始输出非 JSON，coerce 兜底解析：${JSON.stringify(String(d1)).slice(0, 200)}）`);

// ---------- 探针 2：tool 决策 + args 形状（工具调用协议） ----------
console.log("\n[2] tool 探针：给定历史=上一步 inspectTree 失败，期望选一个只读工具重试");
const lastRaw: { text: string } = { text: "" };
const llmDbg = createRealLlm({ onCall: (i) => { lastRaw.text = i.rawText; } });
const d2 = await llmDbg.next({
    system,
    task: "工作目录是 demo 项目。你刚才用 inspectTree 查看目录失败了（目录不存在）。现在请决定下一步：用 mkdir 创建 src 目录，或直接 done。",
    skill: null,
    history: [{ tool: "inspectTree", args: { path: "." }, ok: false, output: "Error: ENOENT: no such file or directory", rejected: null }],
    tools,
    budget: { used: 0, total: 100 },
});
const c2 = coerceDecision(d2);
ok(c2 !== null, "决策可解析");
// 协议服从 = tool/done 二选一都算对；但期望它选工具，所以 tool 分支额外校验 args 形状
ok(c2?.kind === "tool" || c2?.kind === "done", `kind 合法（实际=${c2?.kind ?? "null"}）`);
if (c2?.kind === "tool") {
    ok(typeof c2.call?.tool === "string" && c2.call.tool.length > 0, "tool 分支带工具名");
    console.log(`  选中工具=${c2.call?.tool} args=${JSON.stringify(c2.call?.args).slice(0, 200)}`);
}
// 解析失败时 dump 原始输出，定位是脏格式还是协议不服从
if (c2 === null) console.log(`  —— 原始输出 ——\n${lastRaw.text.slice(0, 2000)}\n  —— dump 结束 ——`);

// ---------- 汇总 ----------
console.log(`\n结果：${pass} 绿 / ${fail} 红，共 ${llm.calls() + llmDbg.calls()} 次真实调用`);
process.exit(fail > 0 ? 1 : 0);
