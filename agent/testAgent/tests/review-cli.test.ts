// ============================================================
// tests/review-cli.test.ts —— --verify 两段式的端到端（零真实 LLM）
//
//   用一个**本地假 OpenAI 兼容服务**当审查模型：
//     · 不开网络出口、不烧真 token、不依赖任何 key；
//     · 但它走的是**真协议**（/chat/completions + JSON body），所以能证明三件事：
//         ① 审查请求体里**没有 tools 字段** —— 模型在协议层就拿不到任何工具，
//            "不能改文件 / 不能改验收脚本"是结构保证，不是提示词保证；
//         ② 机械 verdict 与 outcome 是两件事：机械全绿 + 审查不可用 ≠ 通过；
//         ③ CLI 的 stdout 仍然是一份合法 JSON，日志只走 stderr。
// ============================================================

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const INDEX = path.join(import.meta.dir, "..", "index.ts");
let root: string;
let projectDir: string;

beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ta-review-cli-"));
    projectDir = path.join(root, "proj");
    fs.mkdirSync(path.join(projectDir, "backend", "src"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "backend", "src", "app.js"), "export const app = 1;\n");
});
afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 句柄 */ } }, 30_000);

/** 起一个本地假模型：返回预设审查 JSON，并把收到的请求体存下来供断言 */
function startStubModel(reply: string) {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const server = Bun.serve({
        port: 0,
        async fetch(req) {
            const body = await req.json().catch(() => ({})) as Record<string, unknown>;
            seen.push({ url: new URL(req.url).pathname, body });
            return new Response(JSON.stringify({
                id: "chatcmpl-stub", object: "chat.completion", created: 0, model: "stub-model",
                choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
                usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
            }), { headers: { "content-type": "application/json" } });
        },
    });
    return {
        seen,
        port: server.port,
        stop: () => server.stop(true),
    };
}

const GOOD_REVIEW = JSON.stringify({ reviewVerdict: "pass", findings: [], confidence: "high" });

const req = (over: Record<string, unknown> = {}) => ({
    type: "test_request",
    projectId: "demo", taskId: "demo-p1", runId: "run-1",
    correlationId: "corr-cli", acceptanceHash: "hash-cli",
    projectDir,
    acceptanceChecks: [{ id: "ok", category: "COMPILE", command: "node", args: ["-e", "console.log('ok')"] }],
    ...over,
});

function envWith(over: Record<string, string> = {}): Record<string, string> {
    return {
        PATH: process.env.PATH ?? "",
        ...(process.platform === "win32"
            ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", COMSPEC: process.env.COMSPEC ?? "C:\\windows\\system32\\cmd.exe" }
            : {}),
        ...over,
    };
}

async function runCli(args: string[], env: Record<string, string>, inputName = "req.json", payload?: unknown) {
    if (payload !== undefined) fs.writeFileSync(path.join(root, inputName), JSON.stringify(payload));
    const proc = Bun.spawn([process.execPath, "run", INDEX, ...args], {
        cwd: root, stdout: "pipe", stderr: "pipe", env,
    });
    const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
        new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
}

describe("--verify 两段式 / CLI 契约", () => {
    test("审查模型可用 + 机械全绿 + 审查 pass → outcome=pass，且请求体里没有 tools", async () => {
        const stub = startStubModel(GOOD_REVIEW);
        try {
            const { code, stdout, stderr } = await runCli(
                ["--verify", "--input", "req.json"],
                envWith({
                    DEEPSEEK_API_KEY: "sk-stub", DEEPSEEK_BASE_URL: `http://127.0.0.1:${stub.port}`,
                    DEFAULT_MODEL: "stub-model",
                }),
                "req.json", req(),
            );
            expect(code).toBe(0);
            const v = JSON.parse(stdout);
            expect(v.verdict).toBe("pass");                 // 机械 verdict
            expect(v.mechanicalVerdict).toBe("pass");
            expect(v.outcome).toBe("pass");                 // 最终结论
            expect(v.reviewStatus).toBe("ok");
            expect(v.llmReview?.reviewVerdict).toBe("pass");
            expect(v.reviewAudit?.model).toBe("stub-model");
            expect(v.reviewAudit?.tokenUsage?.totalTokens).toBe(18);
            expect(typeof v.reviewAudit?.promptHash).toBe("string");
            expect(stderr).toContain("[review]");           // 审查日志只走 stderr

            // ★ 协议层无工具：请求体里根本没有 tools / functions 字段
            expect(stub.seen.length).toBe(1);
            expect(stub.seen[0]!.url).toContain("/chat/completions");
            expect("tools" in stub.seen[0]!.body).toBe(false);
            expect("functions" in stub.seen[0]!.body).toBe(false);
            // 机械证据确实送进了 prompt
            const msgs = stub.seen[0]!.body["messages"] as { role: string; content: string }[];
            expect(msgs.some((m) => m.content.includes("机械 verdict"))).toBe(true);
        } finally { stub.stop(); }
    }, 60_000);

    test("审查不可用（没有 key）→ 机械 pass 但 outcome=llm_unavailable，退出码仍是机械的 0", async () => {
        const { code, stdout } = await runCli(
            ["--verify", "--input", "req.json"], envWith(), "req.json", req(),
        );
        expect(code).toBe(0);                               // 退出码按机械 verdict，接口契约不变
        const v = JSON.parse(stdout);
        expect(v.verdict).toBe("pass");
        expect(v.reviewStatus).toBe("LLM_REVIEW_UNAVAILABLE");
        expect(v.outcome).toBe("llm_unavailable");
        expect(v.outcome).toMatch(/llm_unavailable/);
    }, 60_000);

    test("--no-llm-review → 只跑机械段，不联网，outcome 仍不是 pass", async () => {
        const { code, stdout, stderr } = await runCli(
            ["--verify", "--no-llm-review", "--input", "req.json"], envWith(), "req.json", req(),
        );
        expect(code).toBe(0);
        const v = JSON.parse(stdout);
        expect(v.verdict).toBe("pass");
        expect(v.reviewStatus).toBe("disabled");
        expect(v.outcome).toBe("llm_unavailable");
        expect(stderr).not.toContain("/chat/completions");
    }, 60_000);

    test("审查报 critical → 机械仍 pass，但 outcome=fail（不许因为机械绿就放行）", async () => {
        const stub = startStubModel(JSON.stringify({
            reviewVerdict: "pass", confidence: "high",
            findings: [{
                severity: "critical", category: "PLACEHOLDER",
                title: "首页只回 OK", evidence: ["HTTP 200 /：body=OK"], recommendation: "实现真实首页",
            }],
        }));
        try {
            const { code, stdout } = await runCli(
                ["--verify", "--input", "req.json"],
                envWith({
                    DEEPSEEK_API_KEY: "sk-stub", DEEPSEEK_BASE_URL: `http://127.0.0.1:${stub.port}`,
                    DEFAULT_MODEL: "stub-model",
                }),
                "req.json", req(),
            );
            expect(code).toBe(0);                            // 机械 verdict 仍是 pass
            const v = JSON.parse(stdout);
            expect(v.verdict).toBe("pass");
            expect(v.outcome).toBe("fail");
            expect(v.blockingFindings.length).toBe(1);
            expect(v.blockingFindings[0].title).toBe("首页只回 OK");
        } finally { stub.stop(); }
    }, 60_000);

    test("模型返回坏 JSON → LLM_REVIEW_UNAVAILABLE（不猜、不放行）", async () => {
        const stub = startStubModel("我觉得这个项目挺不错的");
        try {
            const { stdout } = await runCli(
                ["--verify", "--input", "req.json"],
                envWith({
                    DEEPSEEK_API_KEY: "sk-stub", DEEPSEEK_BASE_URL: `http://127.0.0.1:${stub.port}`,
                    DEFAULT_MODEL: "stub-model",
                }),
                "req.json", req(),
            );
            const v = JSON.parse(stdout);
            expect(v.reviewStatus).toBe("LLM_REVIEW_UNAVAILABLE");
            expect(v.outcome).toBe("llm_unavailable");
            expect(v.outcomeReason).toContain("不符合契约");
        } finally { stub.stop(); }
    }, 60_000);

    test("机械失败 + 审查发现 → 两者同时出现在结果里（都不许被吞）", async () => {
        const stub = startStubModel(JSON.stringify({
            reviewVerdict: "fail", confidence: "high",
            findings: [
                { severity: "major", category: "PERSISTENCE", title: "内存冒充数据库", evidence: ["x:1"], recommendation: "落库" },
                { severity: "minor", category: "OTHER", title: "缺日志", evidence: [], recommendation: "补日志" },
            ],
        }));
        try {
            const { stdout } = await runCli(
                ["--verify", "--input", "req.json"],
                envWith({
                    DEEPSEEK_API_KEY: "sk-stub", DEEPSEEK_BASE_URL: `http://127.0.0.1:${stub.port}`,
                    DEFAULT_MODEL: "stub-model",
                }),
                "req.json", req({
                    acceptanceChecks: [
                        { id: "bad-a", category: "COMPILE", command: "node", args: ["-e", "process.exit(2)"] },
                        { id: "bad-b", category: "BOOT", command: "node", args: ["-e", "process.exit(3)"] },
                    ],
                }),
            );
            const v = JSON.parse(stdout);
            expect(v.verdict).toBe("fail");
            expect(v.allFailures.map((x: { checkId: string }) => x.checkId)).toEqual(["bad-a", "bad-b"]);
            expect(v.llmReview.findings.length).toBe(2);
            expect(v.blockingFindings.map((f: { title: string }) => f.title)).toEqual(["内存冒充数据库"]);
            expect(v.outcome).toBe("fail");
        } finally { stub.stop(); }
    }, 60_000);
});
