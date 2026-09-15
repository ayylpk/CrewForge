// ============================================================
// tests/testAgentAdapter.test.ts —— 薄适配器的零 LLM 测试
//
//   真实路径：spawn F:\code\agent\testAgent 的 --verify（其本体零 LLM，见该仓测试）；
//   拒绝路径：指向桩 testAgentDir（index.ts 直接吐预设 JSON），钉死
//   "身份不符 / 输出非 JSON / 假 pass / 进程挂死 / 进程起不来"五种都必须变成
//   结构化 ENV 失败——**适配器永不伪造通过**。
// ============================================================

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseInbound } from "../developerAgent/protocol";
import type { TestFailure, TestPassed } from "../developerAgent/protocol";
import {
    VERIFY_AGENT_NAME, runTestAgentVerify,
    type AdapterVerifyRequest, type TestAgentAdapterOptions,
} from "../testAgentAdapter";

const TESTAGENT_DIR = process.env.TESTAGENT_DIR ?? "F:/code/agent/testAgent";

/**
 * 最小环境：**故意不给任何审查模型的 key**。
 *   机械路径的用例都显式用它，免得"恰好读到了本机 .env"就跑出网络调用——
 *   没有 key 时审查段会立刻落 LLM_REVIEW_UNAVAILABLE，一次请求都不发。
 */
const MIN_ENV: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    ...(process.platform === "win32"
        ? {
            SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
            COMSPEC: process.env.COMSPEC ?? "C:\\Windows\\system32\\cmd.exe",
        }
        : {}),
};

let root: string;
let projectDir: string;

beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-adapter-"));
    projectDir = path.join(root, "proj");
    fs.mkdirSync(path.join(projectDir, "backend"), { recursive: true });
    expect(fs.existsSync(path.join(TESTAGENT_DIR, "index.ts"))).toBe(true); // 本机缺仓就直接红，别假装测过
});
afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

function req(overrides: Partial<AdapterVerifyRequest> = {}): AdapterVerifyRequest {
    return {
        projectId: "demo", taskId: "demo-p1", runId: "run-1",
        correlationId: "corr-adapt-1", acceptanceHash: "hash-adapt",
        projectDir,
        acceptanceChecks: [
            { id: "ok-a", category: "COMPILE", command: "node", args: ["-e", "console.log('a')"] },
            { id: "ok-b", category: "CONTRACT", command: "node", args: ["-e", "console.log('b')"], cwd: "backend" },
        ],
        ...overrides,
    };
}

const FAIL_REQ = (): AdapterVerifyRequest => req({
    correlationId: "corr-adapt-fail",
    acceptanceChecks: [
        { id: "ok-a", category: "COMPILE", command: "node", args: ["-e", "console.log('a')"] },
        { id: "bad-b", category: "CONTRACT", command: "node", args: ["-e", "console.error('kaboom: cannot resolve, test failed'); process.exit(7)"] },
    ],
});

/** 造一个假 testAgent 目录：index.ts 原样吐预设内容 */
function stubDir(name: string, body: string): string {
    const d = path.join(root, `stub-${name}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "index.ts"), body, "utf-8");
    return d;
}
const stubOpts = (name: string, body: string, o: Partial<TestAgentAdapterOptions> = {}): TestAgentAdapterOptions =>
    ({ testAgentDir: stubDir(name, body), ...o });

/**
 * 本地假审查模型（OpenAI 兼容的 /chat/completions）。
 *   走的是**真协议**，所以能顺带证明：审查请求体里没有 tools —— 模型拿不到任何工具。
 *   用它是为了不联网、不烧真 token，同时把"机械全绿 + 语义通过 → test_passed"这条正向路走通。
 */
function startStubReviewer(reply: string) {
    const seen: Record<string, unknown>[] = [];
    const server = Bun.serve({
        port: 0,
        async fetch(r) {
            const body = await r.json().catch(() => ({})) as Record<string, unknown>;
            seen.push(body);
            return new Response(JSON.stringify({
                id: "chatcmpl-stub", object: "chat.completion", created: 0, model: "stub-model",
                choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
                usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
            }), { headers: { "content-type": "application/json" } });
        },
    });
    return {
        seen,
        env: {
            ...process.env,
            DEEPSEEK_API_KEY: "sk-stub",
            DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.port}`,
            DEFAULT_MODEL: "stub-model",
        } as Record<string, string>,
        stop: () => server.stop(true),
    };
}
const REVIEW_PASS = JSON.stringify({ reviewVerdict: "pass", findings: [], confidence: "high" });

// ---------- 真实链路（spawn 真 testAgent --verify） ----------

describe("testAgentAdapter / 真实 verify 链路", () => {
    test("机械全绿 + 语义审查通过 → test_passed；证据哈希齐全、入站校验能过", async () => {
        const stub = startStubReviewer(REVIEW_PASS);
        try {
            const out = await runTestAgentVerify(req(), { env: stub.env });
            expect(out.kind).toBe("test_passed");
            if (out.kind !== "test_passed") return;
            const msg: TestPassed = out.message;
            expect(msg.verifiedBy).toBe(VERIFY_AGENT_NAME);
            expect(msg.acceptanceHash).toBe("hash-adapt");
            expect(msg.correlationId).toBe("corr-adapt-1");
            expect(msg.evidence.length).toBe(2);
            expect(msg.evidence.every((e) => e.exitCode === 0)).toBe(true);
            expect(msg.evidence[0]!.stdoutHash).toMatch(/^[0-9a-f]{8,}$/); // hashOf 是 8 位十六进制
            const rt = parseInbound(JSON.stringify(msg));
            expect(rt.ok).toBe(true);
            // 审查确实跑过，且请求体里没有 tools（模型结构上拿不到工具）
            expect(stub.seen.length).toBe(1);
            expect("tools" in stub.seen[0]!).toBe(false);
            expect(out.result.reviewAudit?.model).toBe("stub-model");
        } finally { stub.stop(); }
    }, 120_000);

    test("机械全绿但没有审查模型 → 不可能是 test_passed（needs_human）", async () => {
        const out = await runTestAgentVerify(req({ correlationId: "corr-no-review" }), { env: MIN_ENV });
        expect(out.kind).toBe("needs_human");
        if (out.kind === "needs_human") {
            expect(out.result.reviewStatus).toBe("LLM_REVIEW_UNAVAILABLE");
            expect(out.reasons.join("|")).toContain("语义审查不可用");
        }
    }, 60_000);

    test("机械全绿但审查报 critical → test_failure（origin=llm_review，带三件套）", async () => {
        const stub = startStubReviewer(JSON.stringify({
            reviewVerdict: "pass", confidence: "high",
            findings: [{
                severity: "critical", category: "PLACEHOLDER",
                title: "首页只回 OK", evidence: ["HTTP 200 /：body=OK"], recommendation: "实现真实首页",
            }],
        }));
        try {
            const out = await runTestAgentVerify(req({ correlationId: "corr-review-block" }), { env: stub.env });
            expect(out.kind).toBe("test_failure");
            if (out.kind !== "test_failure") return;
            expect(out.message.origin).toBe("llm_review");
            expect(out.message.blockingFindingTitles?.length).toBe(1);
            // 三件套：机械证据 + LLM 审查（全部失败在本例为空，因为机械全绿）
            expect(out.message.mechanicalEvidence?.length).toBe(2);
            expect(out.message.reviewStatus).toBe("ok");
            expect(out.message.llmReview?.findings[0]?.title).toBe("首页只回 OK");
            expect(out.message.stdout).toContain("首页只回 OK");
        } finally { stub.stop(); }
    }, 120_000);

    test("真实失败 → test_failure：exit=7 原样、stderr 带 kaboom、签名跨轮稳定（重复失败闸能认出）", async () => {
        const a = await runTestAgentVerify(FAIL_REQ(), { env: MIN_ENV });
        expect(a.kind).toBe("test_failure");
        if (a.kind !== "test_failure") return;
        const msg: TestFailure = a.message;
        expect(msg.category).toBe("CONTRACT");
        expect(msg.exitCode).toBe(7);
        expect(msg.stderr).toContain("kaboom");
        expect(msg.acceptanceHash).toBe("hash-adapt");
        // 同判据同错误重跑一轮：failureSignature 必须一致——引擎的重复失败去重靠它
        const b = await runTestAgentVerify(FAIL_REQ(), { env: MIN_ENV });
        expect(b.kind === "test_failure" && b.message.failureSignature).toBe(msg.failureSignature);
    }, 120_000);

    test("命令不存在 → blocked_unverified → unverified（不发 pass 也不发 failure）", async () => {
        const out = await runTestAgentVerify(req({
            correlationId: "corr-adapt-skip",
            acceptanceChecks: [{ id: "ghost", command: "qq-not-installed-9x7" }],
        }), { env: MIN_ENV });
        expect(out.kind).toBe("unverified");
        if (out.kind === "unverified") {
            expect(out.result.skipped.length).toBe(1);
            expect(out.result.skipped[0]!.checkId).toBe("ghost");
        }
    }, 60_000);

    test("testAgentDir 不存在 → 结构化 ENV 失败（不静默、不通过）", async () => {
        const out = await runTestAgentVerify(req({ correlationId: "corr-adapt-env" }),
            { testAgentDir: "F:/definitely/no-such-testagent-dir", env: MIN_ENV });
        expect(out.kind).toBe("test_failure");
        if (out.kind === "test_failure") {
            expect(out.message.category).toBe("ENV");
            // bun 起得来但找不到入口 → stdout 空 → "不是合法 JSON"；bun 都起不来 → "无法启动"
            expect(/JSON|无法启动/.test(out.reasons.join("|"))).toBe(true);
        }
    }, 60_000);
});

// ---------- 拒绝路径（桩 testAgent：五种"想骗过适配器"的形态） ----------

describe("testAgentAdapter / 永不伪造通过", () => {
    test("身份不符（改了 projectId）→ ENV 失败，reasons 点名身份核对", async () => {
        const body = `console.log(JSON.stringify({ verdict:"pass", projectId:"WRONG", taskId:"demo-p1",
            runId:"run-1", correlationId:"corr-adapt-1", acceptanceHash:"hash-adapt",
            evidence:[], skipped:[], failure:null }));`;
        const out = await runTestAgentVerify(req(), stubOpts("identity", body));
        expect(out.kind).toBe("test_failure");
        if (out.kind === "test_failure") {
            expect(out.reasons.join("|")).toContain("身份核对失败");
            expect(out.message.category).toBe("ENV");
        }
    }, 30_000);

    test("输出不是 JSON → ENV 失败", async () => {
        const out = await runTestAgentVerify(req({ correlationId: "corr-garbage" }),
            stubOpts("garbage", `console.log("verdict: pass! 我保证过了");`));
        expect(out.kind).toBe("test_failure");
        if (out.kind === "test_failure") expect(out.reasons.join("|")).toContain("不是合法 JSON");
    }, 30_000);

    test("假 pass（自称 pass 但证据 exit=1 / 条数对不上）→ 复核拒绝，仍 ENV 失败", async () => {
        const body = `console.log(JSON.stringify({ verdict:"pass", projectId:"demo", taskId:"demo-p1",
            runId:"run-1", correlationId:"corr-fakepass", acceptanceHash:"hash-adapt",
            evidence:[{ checkId:"ok-a", category:"COMPILE", command:"node", args:[], cwd:".",
              exitCode:1, startedAt:1, finishedAt:2, durationMs:1, timedOut:false, stdout:"", stderr:"boom" }],
            skipped:[{ checkId:"ok-b", reason:"stub" }], failure:null }));`;
        const out = await runTestAgentVerify(req({ correlationId: "corr-fakepass" }), stubOpts("fakepass", body));
        expect(out.kind).toBe("test_failure");
        if (out.kind === "test_failure") expect(out.reasons.join("|")).toContain("未通过适配器复核");
    }, 30_000);

    test("进程挂死 → 看门狗超时终止并 ENV 失败", async () => {
        const out = await runTestAgentVerify(req({ correlationId: "corr-hang" }),
            stubOpts("hang", `setTimeout(() => console.log("{}"), 60_000);`, { timeoutMs: 1_200 }));
        expect(out.kind).toBe("test_failure");
        if (out.kind === "test_failure") expect(out.reasons.join("|")).toContain("看门狗");
    }, 30_000);

    test("verdict=error（输入被判非法）→ ENV 失败带原因", async () => {
        const body = `console.log(JSON.stringify({ verdict:"error", projectId:"demo", taskId:"demo-p1",
            runId:"run-1", correlationId:"corr-err", acceptanceHash:"hash-adapt",
            evidence:[], skipped:[], failure:null, error:"输入非法：acceptanceChecks 为空" }));`;
        const out = await runTestAgentVerify(req({ correlationId: "corr-err" }), stubOpts("error", body));
        expect(out.kind).toBe("test_failure");
        if (out.kind === "test_failure") expect(out.reasons.join("|")).toContain("acceptanceChecks");
    }, 30_000);

    test("请求本身缺身份 → 直接抛（装配层编程错误，不许进链）", async () => {
        await expect(runTestAgentVerify(req({ correlationId: "" }))).rejects.toThrow(/请求本身不完整/);
    });
});
