// ============================================================
// tool-use-probe.ts —— 原生 tool_use 可行性探针（零改动、可删）
//
//   回答一个问题：当前 relay（.env 配置的端点 + 模型）能不能走
//   Anthropic 原生 tools 协议？
//
//   这决定 realLlm.ts 的升级路线：
//     ✅ 能 → 升级为原生 tool_use（模型用它被训练的方式干活）
//     ❌ 不能 → 保持 JSON 文本协议，另寻优化点
//
//   三步验证（每步只读，不写任何项目文件）：
//     ① 带 tools 请求 → 模型是否回 tool_use 块？
//     ② 回填 tool_result → 能否闭环收尾（end_turn）？
//     ③ 裸请求对照 → 确认端点本身正常（排除网络/鉴权问题）
//
//   跑法：cd agents-CrewForge && bun run developerAgent/live/tool-use-probe.ts
// ============================================================

import fs from "node:fs";
import path from "node:path";

// ---------- 读 .env（只输出变量名存在性，不打印值） ----------

const envPath = path.resolve(import.meta.dir, "..", "..", ".env");
const env: Record<string, string> = {};
if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
        const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim());
        if (m?.[1] !== undefined) env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
    }
}
const baseUrl = (env["ANTHROPIC_BASE_URL"] ?? "").replace(/\/+$/, "");
const token = env["ANTHROPIC_AUTH_TOKEN"] ?? "";
const model = env["DEVELOPER_LLM_MODEL"] ?? "qwen3.8-flash";

console.log("[probe] .env 位置:", envPath, fs.existsSync(envPath) ? "(存在)" : "(缺失)");
console.log("[probe] 端点:", baseUrl || "(空)");
console.log("[probe] 模型:", model);
console.log("[probe] token 已配置:", token !== "");
console.log("");

// ---------- 探针用的假工具 ----------

const TOOLS = [
    {
        name: "write_note",
        description: "把一条笔记写入文件",
        input_schema: {
            type: "object",
            properties: {
                filename: { type: "string", description: "文件名" },
                content: { type: "string", description: "内容" },
            },
            required: ["filename", "content"],
        },
    },
];

interface ProbeResponse {
    content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
    stop_reason?: string;
    usage?: Record<string, unknown>;
}

async function call(messages: unknown[], label: string, withTools: boolean): Promise<ProbeResponse | null> {
    const body: Record<string, unknown> = {
        model,
        max_tokens: 2048,
        system: "你是一个编码助手。需要写文件时必须调用工具，不要只描述。",
        messages,
    };
    if (withTools) {
        body["tools"] = TOOLS;
        // 单步协议的关键参数：一轮最多一个 tool_use（保住 maxSteps 记账语义）
        body["tool_choice"] = { type: "auto", disable_parallel_tool_use: true };
    }

    const t0 = Date.now();
    let res: Response;
    try {
        res = await fetch(`${baseUrl}/v1/messages`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${token}`,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120_000),
        });
    } catch (e) {
        console.log(`[probe] ${label}: ❌ 请求异常（${Date.now() - t0}ms）：${(e as Error).message}`);
        return null;
    }
    const ms = Date.now() - t0;

    if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.log(`[probe] ${label}: ❌ HTTP ${res.status}（${ms}ms）${text.slice(0, 400)}`);
        return null;
    }

    const data = await res.json() as ProbeResponse;
    const kinds = (data.content ?? []).map((b) => b.type).join(", ") || "(空)";
    console.log(`[probe] ${label}: ✅ 200（${ms}ms）stop=${data.stop_reason} blocks=[${kinds}]`);
    return data;
}

// ---------- ① 带 tools 请求：模型是否回 tool_use ----------

console.log("① 带 tools 请求（期望：收到 tool_use 块）");
const r1 = await call(
    [{ role: "user", content: "请在 notes/hello.txt 写入内容：你好，探针。" }],
    "① tools 请求",
    true,
);

let nativeToolUse = false;
if (r1) {
    const tu = (r1.content ?? []).find((b) => b.type === "tool_use");
    if (tu) {
        nativeToolUse = true;
        console.log(`[probe] ✅ 原生 tool_use 可用：name=${tu.name} id=${tu.id}`);
        console.log(`[probe]    参数：${JSON.stringify(tu.input).slice(0, 200)}`);
    } else {
        const textBlock = (r1.content ?? []).find((b) => b.type === "text");
        console.log("[probe] ⚠️ 无 tool_use 块。模型文本输出（前 300 字）：");
        console.log("        " + (textBlock?.text ?? "(无文本)").slice(0, 300).replace(/\n/g, "\n        "));
    }
}

// ---------- ② 回填 tool_result：能否闭环 ----------

if (nativeToolUse && r1) {
    const tu = (r1.content ?? []).find((b) => b.type === "tool_use")!;
    console.log("");
    console.log("② tool_result 回填（期望：模型收尾 end_turn，不再发工具）");
    const r2 = await call(
        [
            { role: "user", content: "请在 notes/hello.txt 写入内容：你好，探针。" },
            { role: "assistant", content: r1.content },
            { role: "user", content: [{ type: "tool_result", tool_use_id: tu.id, content: "已写入 1 条" }] },
        ],
        "② tool_result 回填",
        true,
    );
    if (r2) {
        const stillTool = (r2.content ?? []).some((b) => b.type === "tool_use");
        if (r2.stop_reason === "end_turn" && !stillTool) {
            console.log("[probe] ✅ 闭环成立：模型看到 tool_result 后自然收尾");
        } else {
            console.log(`[probe] ⚠️ 闭环存疑：stop=${r2.stop_reason} 仍有 tool_use=${stillTool}`);
        }
    }
}

// ---------- ③ 裸请求对照 ----------

console.log("");
console.log("③ 裸请求对照（无 tools，期望：正常文本回复）");
await call([{ role: "user", content: "回复两个字：正常" }], "③ 对照组", false);

// ---------- 结论 ----------

console.log("");
console.log("========== 结论 ==========");
if (nativeToolUse) {
    console.log("✅ 该端点支持 Anthropic 原生 tools 协议 → realLlm.ts 可升级为原生 tool_use");
} else {
    console.log("❌ 该端点未返回原生 tool_use → 保持现有 JSON 文本协议");
}
