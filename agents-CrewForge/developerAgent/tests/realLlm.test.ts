// tests/realLlm.test.ts —— 真实 LLM 适配器的离线测试（mock fetch，零网络零 LLM）
//
// 覆盖三层：
//   ① extractJson 纯函数——模型脏输出（围栏/叙述/多对象/字符串内花括号）的抠 JSON 能力；
//   ② 文本协议（nativeTools:false）的 HTTP 契约——**保底路径，行为必须与 9/14 前一致**；
//   ③ 原生 tool_use（缺省）——工具进 tools 字段、tool_use 块出决策、无工具=完成。
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { coerceDecision } from "../graph";
import {
    createRealLlm, extractJson, fromAnthropicContent, toAnthropicTools, renderUserMessage,
    ESCALATED_MAX_TOKENS, isRetryableStatus, parseRetryAfterMs,
    RETRY_AFTER_MAX_MS, RETRY_INITIAL_DELAY_MS, RETRY_MAX_DELAY_MS, RETRY_MAX_RETRIES,
    retryDelayMs, readCacheReadTokens, readCacheCreationTokens,
} from "../realLlm";

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

/** 按序回复的假 fetch：第 N 个请求用 replies[N]（用尽后一直用最后一个） */
function stubSequence(replies: { status?: number; text?: string; body?: unknown; headers?: Record<string, string> }[]) {
    const calls: Captured[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        const i = calls.length;
        calls.push({ url: String(url), init: init ?? {} });
        const reply = replies[Math.min(i, replies.length - 1)]!;
        if (reply.status !== undefined && reply.status !== 200) {
            return new Response(reply.text ?? '{"error":"boom"}', {
                status: reply.status, headers: reply.headers ?? { "content-type": "application/json" },
            });
        }
        const payload = reply.body ?? {
            content: [{ type: "text", text: reply.text ?? "" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 111, output_tokens: 22 },
        };
        return new Response(JSON.stringify(payload), {
            status: 200, headers: reply.headers ?? { "content-type": "application/json" },
        });
    }) as typeof fetch;
    return calls;
}

const BASE_OPTS = { baseUrl: "https://fake.test/apps/anthropic", authToken: "sk-test-123", model: "qwen3.8-flash" };
/** 批 C 集成用例统一用它：退避压到 1ms，测试不真等 */
const FAST_RETRY = { retryInitialDelayMs: 1 };

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
        // maxRetries:0 = 关掉 9/15 批 C 的内部重试，专门验"错误原文原样带出"这一条
        // （重试行为本身在下面「重试退避」一节的用例里验）
        const llm = createRealLlm({ ...BASE_OPTS, maxRetries: 0 });
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

// ---------- 9/15 批 C：重试退避 / max_tokens 升档 / usage 缓存记账 ----------

describe("batchC / retryDelayMs（纯函数：指数 × 对称抖动，双侧有界）", () => {
    it("random=0 取下界、random=1 取上界，最坏不越 RETRY_MAX_DELAY_MS", () => {
        const lo = (r: number) => retryDelayMs(r, () => 0);
        const hi = (r: number) => retryDelayMs(r, () => 1);
        // 第 1 次：500ms 基准，抖动 ±10% → [450, 550]（对齐 dsh retry-policy.ts:17 的 0.1）
        expect(lo(1)).toBeCloseTo(450, 5);
        expect(hi(1)).toBeCloseTo(550, 5);
        // 第 2 次：×2 → [900, 1100]
        expect(lo(2)).toBeCloseTo(900, 5);
        expect(hi(2)).toBeCloseTo(1100, 5);
        // 第 5 次起基准已顶到 8000，**上限只夹上侧**（dsh index.ts:63 同款：
        // 先 min 出 exponential，再乘抖动，最后再 min 一次）——所以下界仍随抖动下浮。
        expect(hi(5)).toBe(RETRY_MAX_DELAY_MS);
        expect(lo(5)).toBeCloseTo(7200, 5);          // 8000 × 0.9
        expect(hi(20)).toBe(RETRY_MAX_DELAY_MS);     // 无论第几次，上界永不越顶
    });

    it("单调不减（同 random 下退避必须逐步拉长，不能倒退）", () => {
        const seq: number[] = [];
        for (let r = 1; r <= 6; r++) seq.push(retryDelayMs(r, () => 0.5));
        for (let i = 1; i < seq.length; i++) expect(seq[i]!).toBeGreaterThanOrEqual(seq[i - 1]!);
    });

    it("对称抖动确实两侧都有（不是 cc 那种只加不减）", () => {
        // 取足够多的样本：必须同时出现小于基准和大于基准的取值
        let below = 0, above = 0;
        for (let i = 0; i < 200; i++) {
            const d = retryDelayMs(1, Math.random);
            if (d < RETRY_INITIAL_DELAY_MS) below++;
            if (d > RETRY_INITIAL_DELAY_MS) above++;
        }
        expect(below).toBeGreaterThan(0);
        expect(above).toBeGreaterThan(0);
    });
});

describe("batchC / 状态码分类（对齐 cc withRetry.ts:696-786 shouldRetry 判定表）", () => {
    it("429 限流 / 5xx 服务端 / 408 超时 / 409 冲突 → 可重试", () => {
        for (const s of [408, 409, 429, 500, 502, 503, 504, 529]) {
            expect(isRetryableStatus(s)).toBe(true);
        }
    });

    it("400 / 401 / 403 / 404 → **不重试**（重发一百次还是同一个错，只会拖慢失败）", () => {
        for (const s of [400, 401, 403, 404, 422]) {
            expect(isRetryableStatus(s)).toBe(false);
        }
    });
});

describe("batchC / parseRetryAfterMs（读服务端指定等待，带上限）", () => {
    it("秒数形式：原样换算", () => {
        expect(parseRetryAfterMs(new Headers({ "retry-after": "3" }))).toBe(3000);
        expect(parseRetryAfterMs(new Headers({ "retry-after": "0" }))).toBe(0);
    });

    it("超过 RETRY_AFTER_MAX_MS 被夹住（防服务端给 3600 把任务挂死）", () => {
        expect(parseRetryAfterMs(new Headers({ "retry-after": "3600" }))).toBe(RETRY_AFTER_MAX_MS);
    });

    it("HTTP-date 形式可解析；缺失/垃圾值返回 null（落回自己的退避公式）", () => {
        const at = new Date(Date.now() + 5000).toUTCString();
        const ms = parseRetryAfterMs(new Headers({ "retry-after": at }));
        expect(ms).toBeGreaterThan(3000);
        expect(ms).toBeLessThanOrEqual(5000);
        expect(parseRetryAfterMs(new Headers())).toBeNull();
        expect(parseRetryAfterMs(new Headers({ "retry-after": "soon-ish" }))).toBeNull();
    });
});

describe("batchC / 重试的接线（mock fetch，零真调用）", () => {
    it("429 → 自动重试；第 2 次成功即返回，calls() 仍只算 1 步", async () => {
        const calls = stubSequence([
            { status: 429, text: "throttling" },
            { body: { content: [{ type: "tool_use", id: "t", name: "readFile", input: { path: "a.ts" } }], stop_reason: "tool_use", usage: { input_tokens: 7, output_tokens: 3 } } },
        ]);
        const infos: { attempts: number; inputTokens: number; outputTokens: number }[] = [];
        const llm = createRealLlm({ ...BASE_OPTS, ...FAST_RETRY, onCall: (i) => infos.push({ attempts: i.attempts, inputTokens: i.inputTokens, outputTokens: i.outputTokens }) });
        const raw = await llm.next({ system: "s", task: "t", skill: null, history: [], tools: [] });

        expect(calls.length).toBe(2);                  // 真发了 2 次
        expect(llm.calls()).toBe(1);                   // 但只是"一步"
        expect(coerceDecision(raw)?.kind).toBe("tool");
        expect(infos.length).toBe(1);                  // onCall 一步只报一次
        expect(infos[0]!.attempts).toBe(2);            // 报出背后发了 2 发
    });

    it("连败超过 RETRY_MAX_RETRIES 才抛错，且错误原文是**最后一次**的", async () => {
        const calls = stubSequence([
            { status: 500, text: "first failure" },
            { status: 503, text: "second failure" },
            { status: 502, text: "final failure" },
        ]);
        const llm = createRealLlm({ ...BASE_OPTS, ...FAST_RETRY });
        await expect(llm.next({ system: "s", task: "t", skill: null, history: [], tools: [] }))
            .rejects.toThrow(/502.*final failure/s);
        expect(calls.length).toBe(1 + RETRY_MAX_RETRIES);   // 1 首发 + 2 重试
    });

    it("4xx（400 请求不合法）**不重试**：一发即抛，别浪费预算", async () => {
        const calls = stubSequence([{ status: 400, text: "bad request" }]);
        const llm = createRealLlm({ ...BASE_OPTS, ...FAST_RETRY });
        await expect(llm.next({ system: "s", task: "t", skill: null, history: [], tools: [] }))
            .rejects.toThrow(/400/);
        expect(calls.length).toBe(1);
    });

    it("maxRetries:0 → 关掉内部重试（行为退回 9/15 前，交 graph 层按步容错）", async () => {
        const calls = stubSequence([{ status: 429, text: "throttling" }]);
        const llm = createRealLlm({ ...BASE_OPTS, maxRetries: 0, ...FAST_RETRY });
        await expect(llm.next({ system: "s", task: "t", skill: null, history: [], tools: [] }))
            .rejects.toThrow(/429/);
        expect(calls.length).toBe(1);
    });

    it("网络层异常（fetch 直接 reject）也重试——连接重置/抖动是瞬时故障", async () => {
        let n = 0;
        globalThis.fetch = (async () => {
            n++;
            if (n === 1) throw new TypeError("fetch failed: ECONNRESET");
            return new Response(JSON.stringify({ content: [{ type: "text", text: "好了" }], stop_reason: "end_turn", usage: {} }), {
                status: 200, headers: { "content-type": "application/json" },
            });
        }) as unknown as typeof fetch;
        const llm = createRealLlm({ ...BASE_OPTS, ...FAST_RETRY });
        const d = coerceDecision(await llm.next({ system: "s", task: "t", skill: null, history: [], tools: [] }));
        expect(d?.kind).toBe("done");
        expect(n).toBe(2);
    });

    it("超时类失败**不重试**（已烧掉整个 timeoutMs，再试就成十二分钟一步）", async () => {
        let n = 0;
        globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
            n++;
            // 模拟"一次请求恰好耗尽超时"：等到 signal 中止，抛出的正是超时错误
            await new Promise((_r, rej) => {
                const s = init?.signal as AbortSignal | undefined;
                const t = setTimeout(() => rej(new Error("模拟：请求超时")), 30);
                s?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("模拟：请求超时")); });
            });
            throw new Error("unreachable");
        }) as unknown as typeof fetch;
        // timeoutMs=20 → 第一次必然超时且耗光预算；退避首档 1ms 也救不回来
        const llm = createRealLlm({ ...BASE_OPTS, timeoutMs: 20, retryInitialDelayMs: 1 });
        await expect(llm.next({ system: "s", task: "t", skill: null, history: [], tools: [] }))
            .rejects.toThrow(/超时/);
        expect(n).toBe(1);                            // 只发了一发
    });

    it("服务端 Retry-After 优先于自身退避（并受 30s 上限保护）", async () => {
        const calls = stubSequence([
            { status: 429, text: "slow down", headers: { "content-type": "application/json", "retry-after": "0" } },
            { text: "完成" },
        ]);
        const startedAt = Date.now();
        const llm = createRealLlm({ ...BASE_OPTS, ...FAST_RETRY });
        await llm.next({ system: "s", task: "t", skill: null, history: [], tools: [] });
        expect(calls.length).toBe(2);
        expect(Date.now() - startedAt).toBeLessThan(1000);   // retry-after:0 → 不该等出自身退避
    });
});

describe("batchC / max_tokens 升档（cc utils/context.ts 8000→64000 同款结构）", () => {
    const truncated = {
        body: {
            content: [{ type: "text", text: "我正在创建" }],
            stop_reason: "max_tokens",
            usage: { input_tokens: 10, output_tokens: 8192 },
        },
    };
    const done = { text: "完成" };

    it("截断 → 用 ESCALATED_MAX_TOKENS 重发同一份请求，升档后正常返回", async () => {
        const calls = stubSequence([truncated, done]);
        const llm = createRealLlm({ ...BASE_OPTS, ...FAST_RETRY });
        const d = coerceDecision(await llm.next({ system: "s", task: "t", skill: null, history: [], tools: [] }));

        expect(calls.length).toBe(2);
        const first = JSON.parse(String(calls[0]!.init.body));
        const second = JSON.parse(String(calls[1]!.init.body));
        expect(first.max_tokens).toBe(8192);
        expect(second.max_tokens).toBe(ESCALATED_MAX_TOKENS);
        // 重发的是"同一份请求"：除 max_tokens 外全部一致（缓存前缀不白费）
        delete first.max_tokens; delete second.max_tokens;
        expect(second).toEqual(first);
        expect(d?.kind).toBe("done");
    });

    it("只升一次：升档后还是截断就不再抬价（不反复烧钱，交上层判失败）", async () => {
        const calls = stubSequence([truncated]);
        const llm = createRealLlm({ ...BASE_OPTS, ...FAST_RETRY });
        const raw = await llm.next({ system: "s", task: "t", skill: null, history: [], tools: [] });
        expect(calls.length).toBe(2);                       // 1 首 + 1 升档，没有第 3 发
        expect(coerceDecision(raw)).toBeNull();             // 仍是截断 → 按一步失败计费
    });

    it("调用方显式给了 maxTokens → 守住不被突破（对齐 cc maxOutputTokensOverride 守卫）", async () => {
        const calls = stubSequence([truncated, done]);
        const llm = createRealLlm({ ...BASE_OPTS, maxTokens: 4096, ...FAST_RETRY });
        await llm.next({ system: "s", task: "t", skill: null, history: [], tools: [] });
        expect(calls.length).toBe(1);                       // 一次都没重发
        expect(JSON.parse(String(calls[0]!.init.body)).max_tokens).toBe(4096);
    });

    it("escalateOnMaxTokens:false → 一键关掉升档", async () => {
        const calls = stubSequence([truncated]);
        const llm = createRealLlm({ ...BASE_OPTS, escalateOnMaxTokens: false, ...FAST_RETRY });
        await llm.next({ system: "s", task: "t", skill: null, history: [], tools: [] });
        expect(calls.length).toBe(1);
    });
});

describe("batchC / usage 缓存记账（只读不发，模型无关）", () => {
    it("cache_read / cache_creation 读到就报；inputTokens 不做减法（Anthropic 协议是互斥计数）", async () => {
        stubFetch({
            body: {
                content: [{ type: "text", text: "完成" }],
                stop_reason: "end_turn",
                usage: {
                    input_tokens: 100, output_tokens: 20,
                    cache_read_input_tokens: 900, cache_creation_input_tokens: 50,
                },
            },
        });
        const seen: { input: number; cacheRead: number; cacheCreation: number }[] = [];
        const llm = createRealLlm({ ...BASE_OPTS, onCall: (i) => seen.push({ input: i.inputTokens, cacheRead: i.cacheReadTokens, cacheCreation: i.cacheCreationTokens }) });
        await llm.next({ system: "s", task: "t", skill: null, history: [], tools: [] });

        expect(seen[0]!.input).toBe(100);            // 原样，**没有**减去缓存命中
        expect(seen[0]!.cacheRead).toBe(900);
        expect(seen[0]!.cacheCreation).toBe(50);
    });

    it("网关不返回缓存字段 → 记 0（不猜、不估）", async () => {
        stubFetch({ text: "完成" });
        const seen: number[] = [];
        const llm = createRealLlm({ ...BASE_OPTS, onCall: (i) => seen.push(i.cacheReadTokens) });
        await llm.next({ system: "s", task: "t", skill: null, history: [], tools: [] });
        expect(seen[0]).toBe(0);
    });

    it("重试/升档时 token 累加（这一步的真实总消耗，计费口径）", async () => {
        // 第 1 发截断（10+8192）→ 升档第 2 发（30+100）：onCall 应报合计
        const calls = stubSequence([
            { body: { content: [{ type: "text", text: "截" }], stop_reason: "max_tokens", usage: { input_tokens: 10, output_tokens: 8192 } } },
            { body: { content: [{ type: "text", text: "好" }], stop_reason: "end_turn", usage: { input_tokens: 30, output_tokens: 100 } } },
        ]);
        const seen: { input: number; output: number; attempts: number }[] = [];
        const llm = createRealLlm({ ...BASE_OPTS, ...FAST_RETRY, onCall: (i) => seen.push({ input: i.inputTokens, output: i.outputTokens, attempts: i.attempts }) });
        await llm.next({ system: "s", task: "t", skill: null, history: [], tools: [] });

        expect(calls.length).toBe(2);
        expect(seen[0]!.input).toBe(40);             // 10 + 30
        expect(seen[0]!.output).toBe(8292);          // 8192 + 100
        expect(seen[0]!.attempts).toBe(2);
    });

    it("escalated 标志把「升档」与「重试」区分开（attempts=2 时 r5 才能分清是哪一种）", async () => {
        const infos: boolean[] = [];
        // 场景一：瞬时故障重试 → escalated=false
        stubSequence([{ status: 503, text: "boom" }, { text: "完成" }]);
        const a = createRealLlm({ ...BASE_OPTS, ...FAST_RETRY, onCall: (i) => infos.push(i.escalated) });
        await a.next({ system: "s", task: "t", skill: null, history: [], tools: [] });
        // 场景二：升档重发 → escalated=true
        stubSequence([
            { body: { content: [{ type: "text", text: "截" }], stop_reason: "max_tokens", usage: {} } },
            { text: "完成" },
        ]);
        const b = createRealLlm({ ...BASE_OPTS, ...FAST_RETRY, onCall: (i) => infos.push(i.escalated) });
        await b.next({ system: "s", task: "t", skill: null, history: [], tools: [] });

        expect(infos).toEqual([false, true]);
    });
});

// ---------- 9/15 批 D：前缀顺序契约 + usage 缓存字段兜底 ----------
//
// 批 D 的探针（live/cache-probe.ts，三组各 4 轮实测）给出了一个**反直觉**的结论：
//   · 现状（单 text 块、无 cache_control）= 命中率 90-93%，命中数恒定 6144，写入恒 0；
//   · 学 cc 打 cache_control（分块 + 稳定段末尾标记）= 命中率腰斩到 47-50%，
//     且每轮多付一笔写入。
// 结论：本网关走**隐式前缀缓存**，我们**不发任何缓存字段**才是这条链表上的最优解。
// 代价是——90% 的命中率**完全依赖"稳定段在前、变化段在后"这个排布**，
// 一旦有人把 history 挪到前面，不会报错、只会悄悄变贵。下面把它钉死。

describe("batchD / 前缀顺序契约（性能关键路径，改了就悄悄变贵）", () => {
    const TOOLS = [{ name: "readFile", description: "读文件", parameters: { path: { type: "string", required: true, description: "路径" } } }];
    const input = (task: string, skill: string | null, history: unknown[]) => ({ task, skill, history });

    it("稳定段（任务/技能）必须整体出现在变化段（history）之前", () => {
        const msg = renderUserMessage(
            input("实现搜索分页", "技能指引X", [{ tool: "readFile", output: "第一轮结果" }]),
            true, TOOLS,
        );
        const taskAt = msg.indexOf("## 任务");
        const skillAt = msg.indexOf("## 当前技能指引");
        const histAt = msg.indexOf("## 已执行步骤");
        expect(taskAt).toBeGreaterThanOrEqual(0);
        expect(skillAt).toBeGreaterThan(taskAt);
        expect(histAt).toBeGreaterThan(skillAt);          // ← 契约：history 在稳定段之后
        expect(msg.indexOf("第一轮结果")).toBeGreaterThan(histAt);
    });

    it("下一轮追加 history 时，稳定段**逐字节不变**（这正是命中 6144 的原因）", () => {
        const r1 = renderUserMessage(input("实现搜索分页", "技能指引X", [{ tool: "readFile", output: "a" }]), true, TOOLS);
        const r2 = renderUserMessage(input("实现搜索分页", "技能指引X", [{ tool: "readFile", output: "a" }, { tool: "readFile", output: "b" }]), true, TOOLS);
        const stableOf = (s: string) => s.slice(0, s.indexOf("## 已执行步骤"));
        // 前缀逐字节相等 = 服务端能命中"最长公共前缀"的前提
        expect(stableOf(r2)).toBe(stableOf(r1));
        expect(r2.startsWith(stableOf(r1))).toBe(true);
    });

    it("**不发任何缓存字段**（批 D 实测结论：显式标记在本网关反而更差）", async () => {
        const calls = stubFetch({ text: "完成" });
        const llm = createRealLlm(BASE_OPTS);
        await llm.next({ system: "你是 Developer。", task: "做个任务", skill: null, history: [], tools: TOOLS });
        const body = JSON.parse(String(calls[0]!.init.body));
        const raw = String(calls[0]!.init.body);
        expect(raw).not.toContain("cache_control");       // 请求体里一个字都不许有
        expect(typeof body.system).toBe("string");        // system 保持字符串，不改成数组
        expect(Array.isArray(body.messages[0].content)).toBe(false);
    });

    it("原生模式工具清单不进文本；文本协议下进文本且仍在稳定段内", () => {
        const nativeMsg = renderUserMessage(input("t", null, []), true, TOOLS);
        expect(nativeMsg).not.toContain("## 可用工具");
        const textMsg = renderUserMessage(input("t", null, [{ tool: "x", output: "y" }]), false, TOOLS);
        const toolAt = textMsg.indexOf("## 可用工具");
        expect(toolAt).toBeGreaterThanOrEqual(0);
        expect(toolAt).toBeLessThan(textMsg.indexOf("## 已执行步骤"));   // 工具清单也属稳定段
    });
});

describe("batchD / usage 缓存字段兜底（网关字段名不止一套）", () => {
    it("Anthropic 风格字段优先；OpenAI 风格 prompt_tokens_details.cached_tokens 兜底", () => {
        // 实测本机网关同时给两套且数值一致（cache-probe 输出 2824/2824）
        expect(readCacheReadTokens({ cache_read_input_tokens: 2824, prompt_tokens_details: { cached_tokens: 2824 } })).toBe(2824);
        // 只给 OpenAI 风格：**必须能读出来**，否则会把"命中"误记成 0（观测骗人）
        expect(readCacheReadTokens({ prompt_tokens_details: { cached_tokens: 1664 } })).toBe(1664);
        // 都没有 → 0，不猜
        expect(readCacheReadTokens({ input_tokens: 100 })).toBe(0);
        expect(readCacheReadTokens(undefined)).toBe(0);
    });

    it("写入侧：平铺字段与 TTL 分档是**同一数值的两种编码**，取 max 不相加", () => {
        // 实测两者相等（cache_creation_input_tokens:2824 与 .ephemeral_5m_input_tokens:2824）
        expect(readCacheCreationTokens({ cache_creation_input_tokens: 2824, cache_creation: { ephemeral_5m_input_tokens: 2824 } })).toBe(2824);
        // 只给分档对象（平铺留 0）→ 不能漏记
        expect(readCacheCreationTokens({ cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 3500 } })).toBe(3500);
        // 分档求和只用于 1h+5m 同时存在的形状
        expect(readCacheCreationTokens({ cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 } })).toBe(300);
        expect(readCacheCreationTokens({})).toBe(0);
    });

    it("缓存命中经 onCall 正常上报（端到端：只给 OpenAI 风格字段也要读到）", async () => {
        stubFetch({
            body: {
                content: [{ type: "text", text: "完成" }], stop_reason: "end_turn",
                usage: { input_tokens: 15, output_tokens: 5, prompt_tokens_details: { cached_tokens: 900 } },
            },
        });
        const seen: number[] = [];
        const llm = createRealLlm({ ...BASE_OPTS, onCall: (i) => seen.push(i.cacheReadTokens) });
        await llm.next({ system: "s", task: "t", skill: null, history: [], tools: [] });
        expect(seen[0]).toBe(900);                        // 批 D 之前这里会是 0
    });
});
