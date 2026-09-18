// ============================================================
// 探针：网关的 prompt caching 到底是哪种语义？（9/15 批 D 取证）
//
// ⚠️ 这是**取证工具**，不是常规体检：每次运行要花 **15 个真实请求**。
//   只在以下两种情况跑：① 换了网关/端点（结论可能翻盘）；② 重新讨论缓存策略。
//   日常验证不需要跑它——结论已经钉在 `tests/realLlm.test.ts` 的 batchD 一节里。
//
// 【本机网关的实测结论（2023-09-15）——这就是"为什么不抄 cc 打 cache_control"的依据】
//   组 A（现状：单 text 块、无标记）= 命中率 90-93%，命中数恒定 6144，写入恒 0；
//   组 B（分块 + 稳定段末尾打 cache_control）= 命中率 47-50%，且**每轮多付一笔写入**
//         （3220→3576，增量正好等于新增 history 的体积）；
//   组 C（B + system 也打标记）= 与 B 完全相同（无增益，不报错）。
//   → 本网关走**隐式前缀缓存**（按最长公共前缀命中），显式标记不但没好处，
//     还把变化段拉进写入计费。我们**不发任何缓存字段**才是最优，且换网关也不会变差。
//   → 推论：命中率完全依赖"稳定段在前、变化段在后"的请求排布，
//     所以那个顺序由测试钉住（`renderUserMessage` 上面的注释 + batchD 用例）。
//
// 三部分的构成：
//   第一部分（3 发）：标记最基本的可用性——同样内容重复请求，能否命中。
//   第二部分（12 发）：**我们的真实形状**——history 嵌在单条 user 消息里且每轮
//     都在追加：A 组 = 现状 / B 组 = 分块+稳定段标记 / C 组 = B+system 标记。
//     各跑 4 轮（history 逐轮 +2 条），比 cache_read 的走势。
//
// 注意边界：本机走的是中转网关（ANTHROPIC_BASE_URL 指向第三方），
//   它的 cache_control 实现**未必等于 Anthropic 官方语义**——结论只对这条链路有效。
// ============================================================
import { loadDotEnv } from "../dotenv";
loadDotEnv();

const baseUrl = (process.env["ANTHROPIC_BASE_URL"] ?? "").replace(/\/+$/, "");
const token = process.env["ANTHROPIC_AUTH_TOKEN"] ?? "";
const model = process.env["DEVELOPER_LLM_MODEL"] ?? "qwen3.8-flash";

// 造一段足够长的 system（缓存有最小 token 门槛，太短不会生效）
const longSystem = "你是一个严谨的编码助手。以下是项目规范：\n" +
    Array.from({ length: 120 }, (_, i) => `规则${i + 1}：所有代码必须类型安全、必须处理错误、必须写注释、必须可测试。`).join("\n");

async function call(label: string, useCache: boolean, msgs: any[]) {
    const sys: any = useCache
        ? [{ type: "text", text: longSystem, cache_control: { type: "ephemeral" } }]
        : longSystem;
    const t0 = Date.now();
    const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 64, system: sys, messages: msgs }),
        signal: AbortSignal.timeout(120_000),
    });
    const ms = Date.now() - t0;
    if (!res.ok) { console.log(`[${label}] HTTP ${res.status} ${(await res.text()).slice(0, 200)}`); return null; }
    const d = await res.json() as any;
    console.log(`[${label}] ${ms}ms  usage=${JSON.stringify(d.usage)}`);
    return d.usage;
}

const msg = [{ role: "user", content: "回复两个字：收到" }];
console.log("=== 第 1 次带 cache_control（期望 cache_creation > 0）===");
await call("cache#1", true, msg);
console.log("=== 第 2 次相同前缀（期望 cache_read > 0）===");
await call("cache#2", true, msg);
console.log("=== 对照组：不带 cache_control ===");
await call("nocache", false, msg);

// ============================================================
// 第二部分：真实形状 × 多轮追加
// ============================================================

/** 像真实请求那样带上 tools（固定 schema，每轮相同） */
const probeTools = [
    { name: "readFile", description: "读取生成项目内的文件内容（相对项目根路径）", input_schema: { type: "object", properties: { path: { type: "string", description: "相对项目根的路径" } }, required: ["path"] } },
    { name: "writeFile", description: "写入生成项目内的文件（相对项目根路径）", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
    { name: "runCommand", description: "在生成项目内执行命令", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
];

const instrText = "请根据以上信息，给出下一步动作（要动手就调用工具；全部完成就直接说明）。";
const historyOf = (n: number) => "## 已执行步骤（按时间顺序，最后一条是上一步结果）\n" + JSON.stringify(
    Array.from({ length: n }, (_, i) => ({ tool: "readFile", args: { path: `src/f${i}.ts` }, ok: true, output: "x".repeat(300) })),
);

/** 每次运行换一个盐：保证第 1 发必然是"全新前缀"，不带上一轮实验的残留缓存 */
const salt = Math.random().toString(36).slice(2, 8);

async function round(label: string, mode: "plain" | "blocks" | "blocks+sys", tag: string, historyN: number) {
    const stable = `## 任务\n[${tag}-${salt}] 实现用户列表页的搜索与分页（探针假任务，只为测缓存前缀）。\n\n## 当前技能指引\n${longSystem}`;
    const historyText = historyOf(historyN);
    const content: any = mode === "plain"
        ? `${stable}\n\n${historyText}\n\n${instrText}`
        : [
            { type: "text", text: stable, cache_control: { type: "ephemeral" } },   // ← 标记打在稳定段末尾
            { type: "text", text: historyText },
            { type: "text", text: instrText },
        ];
    const body: any = {
        model, max_tokens: 16,
        system: mode === "blocks+sys"
            ? [{ type: "text", text: longSystem, cache_control: { type: "ephemeral" } }]
            : longSystem,
        tools: probeTools,
        tool_choice: { type: "auto" },
        messages: [{ role: "user", content }],
    };
    const t0 = Date.now();
    const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
    });
    const ms = Date.now() - t0;
    if (!res.ok) { console.log(`[${label}] HTTP ${res.status} ${(await res.text()).slice(0, 300)}`); return; }
    const d = await res.json() as any;
    const u = d.usage ?? {};
    const miss = u.input_tokens ?? 0, hit = u.cache_read_input_tokens ?? 0, write = u.cache_creation_input_tokens ?? 0;
    const prompt = miss + hit + write;
    const pct = prompt > 0 ? ` (命中率 ${(hit * 100 / prompt).toFixed(1)}%)` : "";
    console.log(`[${label}] ${ms}ms prompt=${prompt} 未命中=${miss} 命中=${hit} 写入=${write}${pct}`);
}

const GROUPS = [
    { mode: "plain", tag: "A", desc: "现状：单 text 块、无标记" },
    { mode: "blocks", tag: "B", desc: "分块 + 标记在稳定段末尾" },
    { mode: "blocks+sys", tag: "C", desc: "B + system 数组也带标记（双标记）" },
] as const;

for (const g of GROUPS) {
    console.log(`\n=== 组 ${g.tag}：${g.desc}（history 逐轮追加，模拟连续 next()）===`);
    for (let r = 1; r <= 4; r++) await round(`${g.tag}#${r}`, g.mode, g.tag, 4 + r * 2);
}
