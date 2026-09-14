// tests/realLlm.test.ts —— 真实 LLM 适配器的离线测试（mock fetch，零网络零 LLM）
//
// 覆盖三层：
//   ① extractJson 纯函数——模型脏输出（围栏/叙述/多对象/字符串内花括号）的抠 JSON 能力；
//   ② 文本协议（nativeTools:false）的 HTTP 契约——**保底路径，行为必须与 9/14 前一致**；
//   ③ 原生 tool_use（缺省）——工具进 tools 字段、tool_use 块出决策、无工具=完成。
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { coerceDecision } from "../graph";
import { createRealLlm, extractJson, fromAnthropicContent, toAnthropicTools } from "../realLlm";

// ---------- ① extractJson：脏输出抠 JSON ----------

describe("realLlm / extractJson", () => {
    it("干净 JSON 直解", () => {
        expect(extractJson('{"kind":"done","note":"ok"}')).toEqual({ kind: "done", note: "ok" });
    });

    it("```json 围栏", () => {
        expect(extractJson('```json\n{"kind":"done"}\n```')).toEqual({ kind: "done" });
    });

    it("前后混叙述文字（探针 2 的实战翻车形状）", () => {
        const raw = 'I will create the directory now.\n{"kind":"tool","call":{"tool":"mkdir","args":{"path":"src"}}}\nLet me know if you need more.';
        expect(extractJson(raw)).toEqual({ kind: "tool", call: { tool: "mkdir", args: { path: "src" } } });
    });

    it("字符串值里带花括号不被括号扫描误切", () => {
        const raw = 'prefix {"kind":"tool","call":{"tool":"writeFile","args":{"content":"a{b}c"}}} suffix';
        const v = extractJson(raw) as { call: { args: { content: string } } };
        expect(v.call.args.content).toBe("a{b}c");
    });

    it("叙述里先出现杂散 { ，跳过坏候选找下一个对象", () => {
        const raw = 'Try {this} first. {"kind":"done","note":"x"}';
        expect(extractJson(raw)).toEqual({ kind: "done", note: "x" });
    });

    it("嵌套对象完整", () => {
        const raw = '{"kind":"tool","call":{"tool":"editFile","args":{"replacements":[{"old":"a","new":"b"}]},"note":"嵌套 {json} 字符串"}}';
        expect(extractJson(raw)).toEqual({
            kind: "tool",
            call: { tool: "editFile", args: { replacements: [{ old: "a", new: "b" }] }, note: "嵌套 {json} 字符串" },
        });
    });

    it("无 JSON 返回 null（交给 coerceDecision 判失败）", () => {
        expect(extractJson("抱歉，我无法完成这个请求。")).toBeNull();
    });
});

// ---------- ② 工具描述转换 ----------

describe("realLlm / toAnthropicTools", () => {
    it("ToolParamSpec → JSON Schema：type 直传、required 取并集、描述原样", () => {
        const out = toAnthropicTools([
            {
                name: "writeFile",
                description: "写文件",
                parameters: {
                    path: { type: "string", required: true, description: "路径" },
                    content: { type: "string", required: true, description: "内容" },
                    overwrite: { type: "boolean", required: false, description: "覆盖" },
                },
            },
        ]) as { name: string; description: string; input_schema: { type: string; properties: Record<string, unknown>; required: string[] } }[];

        expect(out.length).toBe(1);
        expect(out[0]!.name).toBe("writeFile");
        expect(out[0]!.description).toBe("写文件");
        expect(out[0]!.input_schema.type).toBe("object");
        expect(Object.keys(out[0]!.input_schema.properties)).toEqual(["path", "content", "overwrite"]);
        expect(out[0]!.input_schema.required).toEqual(["path", "content"]);   // overwrite 非必需 → 不进 required
    });

    it("无参数工具 → 空 properties / 空 required（合法 schema，不是 undefined）", () => {
        const out = toAnthropicTools([{ name: "listTools", description: "列出工具", parameters: {} }]) as {
            input_schema: { properties: Record<string, unknown>; required: string[] };
        }[];
        expect(out[0]!.input_schema.properties).toEqual({});
        expect(out[0]!.input_schema.required).toEqual([]);
    });
});

// ---------- ③ 响应消化纯函数 ----------

describe("realLlm / fromAnthropicContent", () => {
    it("有 tool_use → 扁平决策（与 coerceDecision 协议一致）", () => {
        const r = fromAnthropicContent(
            [{ type: "tool_use", id: "tu_1", name: "mkdir", input: { path: "src" } }],
            "tool_use",
        );
        expect(r).toEqual({ kind: "tool", tool: "mkdir", args: { path: "src" }, note: "" });
        expect(coerceDecision(r)?.call?.tool).toBe("mkdir");
    });

    it("thinking + tool_use：thinking 块被忽略，工具照常取出", () => {
        const r = fromAnthropicContent(
            [
                { type: "thinking" },
                { type: "tool_use", id: "tu_2", name: "writeFile", input: { path: "a.txt", content: "x" } },
            ],
            "tool_use",
        );
        expect(coerceDecision(r)?.call?.tool).toBe("writeFile");
    });

    it("文本 + tool_use：文本进 note，不丢模型的说明", () => {
        const r = fromAnthropicContent(
            [
                { type: "text", text: "先建目录" },
                { type: "tool_use", id: "tu_3", name: "mkdir", input: { path: "d" } },
            ],
            "tool_use",
        ) as { note: string };
        expect(r.note).toBe("先建目录");
    });

    it("网关不认 disable_parallel_tool_use 回了多个：只用第一个，note 留警告", () => {
        const r = fromAnthropicContent(
            [
                { type: "tool_use", id: "tu_a", name: "mkdir", input: { path: "a" } },
                { type: "tool_use", id: "tu_b", name: "mkdir", input: { path: "b" } },
            ],
            "tool_use",
        ) as { note: string; tool: string };
        expect(r.tool).toBe("mkdir");
        expect(r.note).toContain("警告");
        expect(r.note).toContain("2 个 tool_use");
    });

    // ↓ ③并行（9/14）：多 tool_use 的两条新路径

    it("多个只读 tool_use → batch（一次并发执行，省往返）", () => {
        const r = fromAnthropicContent(
            [
                { type: "tool_use", id: "tu_1", name: "readFile", input: { path: "a.ts" } },
                { type: "tool_use", id: "tu_2", name: "search", input: { query: "login" } },
                { type: "tool_use", id: "tu_3", name: "inspectTree", input: { limit: 50 } },
            ],
            "tool_use",
        );
        const d = coerceDecision(r);
        expect(d?.kind).toBe("batch");
        expect(d?.batch?.map((c) => c.tool)).toEqual(["readFile", "search", "inspectTree"]);
        expect(d?.batch?.[0]?.args).toEqual({ path: "a.ts" });
    });

    it("多 tool_use 混入写工具 → 整包降级只取第一个（写/执行一轮一个不受影响）", () => {
        const r = fromAnthropicContent(
            [
                { type: "tool_use", id: "tu_1", name: "readFile", input: { path: "a.ts" } },
                { type: "tool_use", id: "tu_2", name: "writeFile", input: { path: "b.ts", content: "x" } },
                { type: "tool_use", id: "tu_3", name: "readFile", input: { path: "c.ts" } },
            ],
            "tool_use",
        ) as { kind: string; tool: string; note: string };
        expect(r.kind).toBe("tool");
        expect(r.tool).toBe("readFile");
        expect(r.note).toContain("警告");
    });

    it("batch 混入非只读工具时 coerceDecision 判 null（第二道防线，不信上游）", () => {
        // 直接构造畸形 batch：绕过 fromAnthropicContent 的白名单，测 coerceDecision 自己的闸
        expect(coerceDecision({
            kind: "batch",
            calls: [
                { tool: "readFile", args: { path: "a" } },
                { tool: "runCommand", args: { command: "rm" } },
            ],
        })).toBeNull();
        // 空 batch / 形状不对也判 null
        expect(coerceDecision({ kind: "batch", calls: [] })).toBeNull();
        expect(coerceDecision({ kind: "batch" })).toBeNull();
    });

    it("无工具 + end_turn → done（模型不再调用工具 = 自然完成信号）", () => {
        const r = fromAnthropicContent([{ type: "text", text: "四周已经做完。" }], "end_turn");
        expect(r).toEqual({ kind: "done", note: "四周已经做完。" });
    });

    it("无工具 + max_tokens（截断）→ 返回原文，判失败不计成 done", () => {
        const r = fromAnthropicContent([{ type: "text", text: "我正在" }], "max_tokens");
        expect(coerceDecision(r)).toBeNull();   // 截断的决策不可信，按一步失败计费
    });

    it("input 不是对象（网关畸形返回）→ args 归零，不抛错", () => {
        const r = fromAnthropicContent([{ type: "tool_use", id: "x", name: "mkdir", input: "oops" }], "tool_use") as {
            args: Record<string, unknown>;
        };
        expect(r.args).toEqual({});
    });
});

// ---------- ④ HTTP 契约（mock fetch） ----------

type Captured = { url: string; init: RequestInit };
const realFetch = globalThis.fetch;

/** 装一个假 fetch：所有请求先落捕鼠夹，再按 reply 造 Anthropic 形状响应 */
function stubFetch(reply: { status?: number; text?: string; body?: unknown }) {
    const calls: Captured[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        const payload = reply.body ?? {
            content: [{ type: "text", text: reply.text ?? "" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 111, output_tokens: 22 },
        };
        return new Response(JSON.stringify(payload), {
            status: reply.status ?? 200,
            headers: { "content-type": "application/json" },
        });
    }) as typeof fetch;
    return calls;
}

const BASE_OPTS = { baseUrl: "https://fake.test/apps/anthropic", authToken: "sk-test-123", model: "qwen3.8-flash" };

beforeEach(() => { globalThis.fetch = realFetch; });
afterEach(() => { globalThis.fetch = realFetch; });

describe("realLlm / HTTP 契约（公共）", () => {
    it("缺端点 / 缺 token 构造期直接炸（fail fast，不带病上场）", () => {
        const savedBase = process.env.ANTHROPIC_BASE_URL;
        const savedTok = process.env.ANTHROPIC_AUTH_TOKEN;
        process.env.ANTHROPIC_BASE_URL = "";
        process.env.ANTHROPIC_AUTH_TOKEN = "";
        try {
            expect(() => createRealLlm({ baseUrl: "" })).toThrow("ANTHROPIC_BASE_URL");
            expect(() => createRealLlm({ ...BASE_OPTS, authToken: "" })).toThrow("ANTHROPIC_AUTH_TOKEN");
        } finally {
            process.env.ANTHROPIC_BASE_URL = savedBase;
            process.env.ANTHROPIC_AUTH_TOKEN = savedTok;
        }
    });

    it("非 2xx → 抛错并带状态码与响应体片段（网关错误原文可见）", async () => {
        globalThis.fetch = (async () =>
            new Response('{"error":{"message":"throttling: too many requests"}}', { status: 429 })) as unknown as typeof fetch;
        const llm = createRealLlm(BASE_OPTS);
        await expect(llm.next({ system: "s", task: "t", skill: null, history: [], tools: [] }))
            .rejects.toThrow(/429.*throttling/s);
    });

    it("calls() 计数逐次累加；onCall 收到 token 用量、原文与模式", async () => {
        stubFetch({ text: '{"kind":"done"}' });
        const seen: { seq: number; mode: string }[] = [];
        const llm = createRealLlm({
            ...BASE_OPTS,
            onCall: (i) => { seen.push({ seq: i.seq, mode: i.mode }); expect(i.rawText).toContain("kind"); },
        });
        expect(llm.calls()).toBe(0);
        await llm.next({ system: "s", task: "t", skill: null, history: [], tools: [] });
        await llm.next({ system: "s", task: "t", skill: null, history: [], tools: [] });
        expect(llm.calls()).toBe(2);
        expect(seen).toEqual([{ seq: 1, mode: "native" }, { seq: 2, mode: "native" }]);
    });
});

describe("realLlm / 原生 tool_use（缺省模式）", () => {
    const TOOLS = [{ name: "readFile", description: "读文件", parameters: { path: { type: "string", required: true, description: "路径" } } }];

    it("请求带 tools + tool_choice:auto（③并行：并行已放开）；工具清单不再进文本", async () => {
        const calls = stubFetch({ text: "ok" });
        const llm = createRealLlm(BASE_OPTS);
        await llm.next({ system: "你是 Developer。", task: "做个任务", skill: "技能指引X", history: [], tools: TOOLS });

        const body = JSON.parse(String(calls[0]!.init.body));
        expect(body.tools.length).toBe(1);
        expect(body.tools[0].name).toBe("readFile");
        expect(body.tools[0].input_schema.properties.path.type).toBe("string");
        // 9/14 ③并行：disable_parallel_tool_use 撤下，记账语义改由解析层白名单+批处理保证
        expect(body.tool_choice).toEqual({ type: "auto" });
        expect(body.system).toContain("你是 Developer。");
        expect(body.system).toContain("原生工具");                 // 原生协议说明
        const user = body.messages[0].content as string;
        expect(user).not.toContain("## 可用工具");                  // 工具走字段，不重复进文本
        expect(user).toContain("技能指引X");                        // 其他上下文照旧
    });

    it("工具为空时不发 tools/tool_choice（避免畸形请求）", async () => {
        const calls = stubFetch({ text: "完成" });
        const llm = createRealLlm(BASE_OPTS);
        await llm.next({ system: "s", task: "t", skill: null, history: [], tools: [] });
        const body = JSON.parse(String(calls[0]!.init.body));
        expect(body.tools).toBeUndefined();
        expect(body.tool_choice).toBeUndefined();
    });

    it("tool_use 响应 → coerceDecision 直接可用（端到端穿透）", async () => {
        stubFetch({
            body: {
                content: [{ type: "tool_use", id: "tu_9", name: "readFile", input: { path: "src/a.ts" } }],
                stop_reason: "tool_use",
                usage: { input_tokens: 50, output_tokens: 10 },
            },
        });
        const llm = createRealLlm(BASE_OPTS);
        const raw = await llm.next({ system: "s", task: "t", skill: null, history: [], tools: TOOLS });
        const d = coerceDecision(raw);
        expect(d).toEqual({ kind: "tool", call: { tool: "readFile", args: { path: "src/a.ts" }, note: "" } });
    });

    it("无工具响应 → done（完成信号不再依赖模型手写 JSON）", async () => {
        stubFetch({ text: "四周已经做完。" });
        const llm = createRealLlm(BASE_OPTS);
        const d = coerceDecision(await llm.next({ system: "s", task: "t", skill: null, history: [], tools: TOOLS }));
        expect(d).toEqual({ kind: "done", note: "四周已经做完。" });
    });
});

describe("realLlm / 文本协议保底（nativeTools:false，行为与 9/14 前一致）", () => {
    const LEGACY = { ...BASE_OPTS, nativeTools: false };
    const TOOLS = [{ name: "readFile", description: "读文件", parameters: {} }];

    it("请求形状：工具进文本、system 带 JSON 输出协议、不发 tools 字段", async () => {
        const calls = stubFetch({ text: '{"kind":"done","note":"pong"}' });
        const llm = createRealLlm(LEGACY);
        await llm.next({
            system: "你是 Developer。", task: "做个任务", skill: "技能指引X",
            history: [{ tool: "readFile", ok: true, output: "内容" }],
            tools: TOOLS,
        });

        const body = JSON.parse(String(calls[0]!.init.body));
        expect(body.tools).toBeUndefined();
        expect(body.tool_choice).toBeUndefined();
        expect(body.system).toContain("输出协议");
        const user = body.messages[0].content as string;
        expect(user).toContain("做个任务");
        expect(user).toContain("技能指引X");
        expect(user).toContain("readFile");          // 旧协议：工具清单进文本
        expect(user).toContain("已执行步骤");
    });

    it("正常响应 → 扁平决策（9/12 冒烟教训的形状）", async () => {
        stubFetch({ text: '{"kind":"tool","tool":"mkdir","args":{"path":"src"}}' });
        const llm = createRealLlm(LEGACY);
        const d = coerceDecision(await llm.next({ system: "s", task: "t", skill: null, history: [], tools: [] }));
        expect(d).toEqual({ kind: "tool", call: { tool: "mkdir", args: { path: "src" }, note: "" } });
    });

    it("脏输出（叙述+JSON）也能出正确决策", async () => {
        stubFetch({ text: 'Sure! I will create src dir first.\n{"kind":"tool","tool":"mkdir","args":{"path":"src"},"note":"建目录"}\nDone.' });
        const llm = createRealLlm(LEGACY);
        const d = coerceDecision(await llm.next({ system: "s", task: "t", skill: null, history: [], tools: [] }));
        expect(d?.kind).toBe("tool");
        expect(d?.call?.note).toBe("建目录");
    });

    it("完全无 JSON → 原文字符串返回，coerceDecision 判 null（按一步失败计费）", async () => {
        stubFetch({ text: "我不知道该做什么。" });
        const llm = createRealLlm(LEGACY);
        const raw = await llm.next({ system: "s", task: "t", skill: null, history: [], tools: [] });
        expect(raw).toBe("我不知道该做什么。");
        expect(coerceDecision(raw)).toBeNull();
    });

    it("env DEVELOPER_LLM_NATIVE_TOOLS=0 也能关（运维开关生效）", async () => {
        const saved = process.env.DEVELOPER_LLM_NATIVE_TOOLS;
        process.env.DEVELOPER_LLM_NATIVE_TOOLS = "0";
        try {
            const calls = stubFetch({ text: '{"kind":"done"}' });
            const llm = createRealLlm({ ...BASE_OPTS });
            await llm.next({ system: "s", task: "t", skill: null, history: [], tools: TOOLS });
            const body = JSON.parse(String(calls[0]!.init.body));
            expect(body.tools).toBeUndefined();          // 已退回文本协议
        } finally {
            if (saved === undefined) delete process.env.DEVELOPER_LLM_NATIVE_TOOLS;
            else process.env.DEVELOPER_LLM_NATIVE_TOOLS = saved;
        }
    });
});
