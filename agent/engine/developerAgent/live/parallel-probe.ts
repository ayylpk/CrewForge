// 探针：不设 disable_parallel_tool_use 时，模型/网关会不会一轮返回多个 tool_use？
// 这决定"一次 API 调用 = 多个工具执行"的并行化是否可行（CC/pi 的主要提速手段之一）。
import { loadDotEnv } from "../dotenv";
loadDotEnv();

const baseUrl = (process.env["ANTHROPIC_BASE_URL"] ?? "").replace(/\/+$/, "");
const token = process.env["ANTHROPIC_AUTH_TOKEN"] ?? "";
const model = process.env["DEVELOPER_LLM_MODEL"] ?? "qwen3.8-flash";

const TOOLS = ["a", "b", "c", "d"].map((n) => ({
    name: `read_${n}`,
    description: `读取文件 ${n}.txt`,
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
}));

const t0 = Date.now();
const res = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
        model, max_tokens: 2048,
        system: "你有工具可用。用户要求一次读取多个文件时，请在同一轮里同时调用所有需要的工具。",
        messages: [{ role: "user", content: "请同时读取 a.txt、b.txt、c.txt、d.txt 这四个文件的内容。" }],
        tools: TOOLS,
        // 注意：**不设** disable_parallel_tool_use
    }),
    signal: AbortSignal.timeout(120_000),
});
const ms = Date.now() - t0;
if (!res.ok) { console.log("HTTP", res.status, (await res.text()).slice(0, 300)); process.exit(1); }
const data = await res.json() as any;
const tu = ((data.content ?? []) as any[]).filter((b) => b.type === "tool_use");
console.log(`[probe] ${ms}ms stop=${data.stop_reason}`);
console.log(`[probe] tool_use 块数量 = ${tu.length}  ${tu.length > 1 ? "✅ 支持并行" : "❌ 一次只给一个"}`);
for (const t of tu) console.log(`   - ${t.name} ${JSON.stringify(t.input)}`);
console.log(`[probe] usage =`, JSON.stringify(data.usage));
