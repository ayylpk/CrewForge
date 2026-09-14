// ============================================================
// tests/llm-review.test.ts —— 适配器的语义闸（零 LLM / Fake LLM）
//
//   覆盖上游要求里与"两段式裁判"直接相关的条目：
//     · 机械 pass + 审查 critical/major → 不许 test_passed（要求 10）；
//     · 机械 pass + 审查不可用 / 不确定 / 低置信 → needs_human，不伪装通过（要求 11、15）；
//     · 不轻信 verify 自报的 outcome —— 适配器按 reviewStatus + findings 独立复核；
//     · 机械失败 + LLM 发现 → 三件套（mechanicalEvidence / allFailures / llmReview）一起下发（要求 13）；
//     · findings 全量进 Developer 的修复提示词，不截成一条（要求 12、14）。
//
//   全部离线：要么是纯函数，要么是"桩 testAgent 直接吐预设 JSON"。
// ============================================================

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    buildReviewLedgerPayload, collectBlockingFindings, renderFindings, runTestAgentVerify, semanticGateReasons,
} from "../../testAgentAdapter";
import type {
    AdapterLlmReview, AdapterReviewFinding, AdapterVerifyRequest, AdapterVerifyResult,
    TestAgentAdapterOptions,
} from "../../testAgentAdapter";
import { renderReviewFindings } from "../graph";
import type { TestFailure } from "../protocol";

const stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cf-llm-review-"));
const projectDir = path.join(stubRoot, "proj");
fs.mkdirSync(projectDir, { recursive: true });

function stubOpts(name: string, body: string, o: Partial<TestAgentAdapterOptions> = {}): TestAgentAdapterOptions {
    const d = path.join(stubRoot, `stub-${name}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "index.ts"), body, "utf-8");
    return { testAgentDir: d, ...o };
}

const PASS_EVIDENCE = [
    { checkId: "ok-a", category: "COMPILE", command: "node", args: [], cwd: ".", exitCode: 0, startedAt: 1, finishedAt: 2, durationMs: 1, timedOut: false, stdout: "a", stderr: "" },
    { checkId: "ok-b", category: "CONTRACT", command: "node", args: [], cwd: ".", exitCode: 0, startedAt: 3, finishedAt: 4, durationMs: 1, timedOut: false, stdout: "b", stderr: "" },
];
const FAIL_EVIDENCE = { checkId: "ok-b", category: "CONTRACT", command: "node", args: ["probe"], cwd: ".", exitCode: 2, startedAt: 3, finishedAt: 4, durationMs: 1, timedOut: false, stdout: "OUT-B", stderr: "ERR-B" };

/** 桩 testAgent：直接吐预设结果 JSON（不走真 verify，所以是纯适配器逻辑测试） */
function stubBody(corr: string, over: Record<string, unknown>): string {
    return `console.log(JSON.stringify({
        projectId:"demo", taskId:"demo-p1", runId:"run-1",
        correlationId:${JSON.stringify(corr)}, acceptanceHash:"hash-review",
        evidence:[], skipped:[], failure:null, allFailures:[],
        ${Object.entries(over).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",\n")}
    }));`;
}

const req = (corr: string): AdapterVerifyRequest => ({
    projectId: "demo", taskId: "demo-p1", runId: "run-1",
    correlationId: corr, acceptanceHash: "hash-review",
    projectDir,
    acceptanceChecks: [
        { id: "ok-a", category: "COMPILE", command: "node", args: ["-e", "console.log('a')"] },
        { id: "ok-b", category: "CONTRACT", command: "node", args: ["-e", "console.log('b')"] },
    ],
});

const finding = (sev: "critical" | "major" | "minor", cat: string, title: string): AdapterReviewFinding => ({
    severity: sev, category: cat, title,
    evidence: [`${title} 的证据`], recommendation: "按建议修",
});

/** 审查结论（显式标注字面量，避免对象字面量被推断成 string） */
const llm = (
    v: "pass" | "fail" | "uncertain",
    c: "high" | "medium" | "low",
    fs: AdapterReviewFinding[] = [],
): AdapterLlmReview => ({ reviewVerdict: v, findings: fs, confidence: c });

const AUDIT = { model: "stub-model", promptHash: "ph", evidenceHash: "eh", durationMs: 12, tokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } };

// ============================================================
// 一、纯函数：阻断项 / 语义闸 / 渲染
// ============================================================

describe("适配器 / 阻断项与语义闸（纯函数）", () => {
    test("collectBlockingFindings 只取 critical/major，并按 severity+category+title 去重", () => {
        const b = collectBlockingFindings({
            reviewSignals: [finding("critical", "PLACEHOLDER", "首页占位"), finding("minor", "OTHER", "小问题")],
            llmReview: {
                reviewVerdict: "pass", confidence: "high",
                findings: [finding("critical", "PLACEHOLDER", "首页占位"), finding("major", "PERSISTENCE", "内存库")],
            },
        });
        expect(b.map((f) => f.title)).toEqual(["首页占位", "内存库"]);   // minor 被排除、重复被去掉
        expect(b.map((f) => f.severity)).toEqual(["critical", "major"]);
    });

    test("semanticGateReasons：审查禁用 / 不可用 / 不确定 / 低置信 / 自报非 pass 逐条拦住", () => {
        const base = { reviewSignals: [], blockingFindings: [], llmReview: null };
        expect(semanticGateReasons({ ...base, reviewStatus: "disabled" }).join("|")).toContain("未启用");
        expect(semanticGateReasons({ ...base, reviewStatus: "LLM_REVIEW_UNAVAILABLE", reviewReason: "402" }).join("|")).toContain("402");
        expect(semanticGateReasons({ ...base, reviewStatus: "ok", llmReview: llm("uncertain", "medium") }).join("|"))
            .toContain("uncertain");
        expect(semanticGateReasons({ ...base, reviewStatus: "ok", llmReview: llm("pass", "low") }).join("|"))
            .toContain("置信度 low");
        // reviewStatus=ok 却没带 llmReview —— 输出自相矛盾也要拦
        expect(semanticGateReasons({ ...base, reviewStatus: "ok" }).join("|")).toContain("自相矛盾");
        // 自报 outcome 非 pass 时也要拦（不轻信 verify 的自述）
        expect(semanticGateReasons({
            ...base, reviewStatus: "ok", outcome: "uncertain", llmReview: llm("pass", "high"),
        }).join("|")).toContain("outcome=uncertain");
        // 全部满足 → 没有拦住它的理由
        expect(semanticGateReasons({
            ...base, reviewStatus: "ok", outcome: "pass", llmReview: llm("pass", "high"),
        })).toEqual([]);
    });

    test("renderReviewFindings：全量返回（不 slice）、阻断项优先、缺证据也如实标注", () => {
        const f = {
            reviewSignals: [finding("minor", "OTHER", "缺日志")],
            llmReview: llm("fail", "high", [finding("major", "PERSISTENCE", "内存冒充数据库"), finding("critical", "PLACEHOLDER", "首页占位")]),
            reviewStatus: "ok" as const, reviewReason: null,
        };
        const text = renderReviewFindings(f);
        expect(text).toContain("内存冒充数据库");
        expect(text).toContain("首页占位");
        expect(text).toContain("缺日志");                       // minor 也不许被丢掉
        expect(text.split("\n").filter((l) => l.startsWith("#")).length).toBe(3);
        // critical 排在 major 前面
        expect(text.indexOf("首页占位")).toBeLessThan(text.indexOf("内存冒充数据库"));
        // 无证据的发现要如实写"（未给证据）"，不能凭空补
        const noEv = renderReviewFindings({
            reviewSignals: [], reviewStatus: "ok", reviewReason: null,
            llmReview: llm("uncertain", "low", [{ severity: "minor", category: "OTHER", title: "猜测", evidence: [], recommendation: "人工看" }]),
        });
        expect(noEv).toContain("（未给证据）");
    });

    test("renderReviewFindings：审查不可用 / 未启用时给出明确提示，不伪装成没问题", () => {
        expect(renderReviewFindings({ reviewSignals: [], llmReview: null, reviewStatus: "LLM_REVIEW_UNAVAILABLE", reviewReason: "超时" }))
            .toContain("语义审查不可用");
        expect(renderReviewFindings({ reviewSignals: [], llmReview: null, reviewStatus: "disabled", reviewReason: null }))
            .toContain("未启用");
        expect(renderReviewFindings(null)).toContain("没有 TestAgent 失败证据");
    });

    test("renderFindings 也全量渲染（适配器侧的同一份逻辑）", () => {
        const text = renderFindings([finding("major", "UI", "A") as never, finding("minor", "OTHER", "B") as never]);
        expect(text).toContain("A");
        expect(text).toContain("B");
    });

    test("buildReviewLedgerPayload：审计字段齐全且 findings 全量（要求 19）", () => {
        const payload = buildReviewLedgerPayload({
            verdict: "pass", projectId: "p", taskId: "t", runId: "r",
            correlationId: "c", acceptanceHash: "h",
            evidence: [], skipped: [], failure: null,
            mechanicalVerdict: "pass", outcome: "fail",
            reviewStatus: "ok",
            reviewSignals: [finding("major", "PERSISTENCE", "内存库")],
            llmReview: llm("fail", "high", [finding("critical", "PLACEHOLDER", "首页占位")]),
            reviewAudit: AUDIT,
        }, { correlationId: "c", taskId: "t" });

        expect(payload["model"]).toBe("stub-model");
        expect(payload["promptHash"]).toBe("ph");
        expect(payload["evidenceHash"]).toBe("eh");
        expect(payload["durationMs"]).toBe(12);
        expect(payload["tokenUsage"]).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
        expect(payload["findingCount"]).toBe(2);
        const findings = payload["findings"] as { title: string; origin: string }[];
        expect(findings.map((f) => f.title).sort()).toEqual(["内存库", "首页占位"]);   // 全量，不是第一条
        expect(findings.map((f) => f.origin).sort()).toEqual(["llm", "prescan"]);       // 来源可区分
        expect(payload["blocking"]).toEqual(["major/PERSISTENCE 内存库", "critical/PLACEHOLDER 首页占位"]);
        expect(payload["mechanicalVerdict"]).toBe("pass");                              // 机械与最终分开记
        expect(payload["outcome"]).toBe("fail");
    });
});

// ============================================================
// 二、适配器端到端（桩 testAgent）
// ============================================================

describe("适配器 / 语义闸端到端", () => {
    test("机械全绿 + 审查 ok/pass/high 且无 finding → test_passed", async () => {
        const corr = "corr-pass";
        const out = await runTestAgentVerify(req(corr), stubOpts("sem-pass", stubBody(corr, {
            verdict: "pass", evidence: PASS_EVIDENCE,
            mechanicalVerdict: "pass", outcome: "pass", outcomeReason: "双段通过",
            reviewStatus: "ok", reviewReason: null,
            llmReview: { reviewVerdict: "pass", findings: [], confidence: "high" },
            reviewSignals: [], blockingFindings: [], reviewAudit: AUDIT,
        })));
        expect(out.kind).toBe("test_passed");
        if (out.kind === "test_passed") expect(out.message.evidence.length).toBe(2);
    }, 60_000);

    test("机械全绿但审查报 major → test_failure（origin=llm_review，三件套齐全）", async () => {
        const corr = "corr-major";
        const out = await runTestAgentVerify(req(corr), stubOpts("sem-major", stubBody(corr, {
            verdict: "pass", evidence: PASS_EVIDENCE,
            mechanicalVerdict: "pass", outcome: "fail", outcomeReason: "存在 1 条阻断性发现",
            reviewStatus: "ok",
            llmReview: { reviewVerdict: "pass", findings: [finding("major", "PERSISTENCE", "内存冒充数据库")], confidence: "high" },
            reviewSignals: [], blockingFindings: [finding("major", "PERSISTENCE", "内存冒充数据库")],
            reviewAudit: AUDIT,
        })));
        expect(out.kind).toBe("test_failure");
        if (out.kind !== "test_failure") return;
        expect(out.message.origin).toBe("llm_review");
        expect(out.message.blockingFindingTitles).toEqual(["major/PERSISTENCE 内存冒充数据库"]);
        expect(out.message.mechanicalEvidence?.length).toBe(2);      // 机械证据
        expect(out.message.allFailures).toEqual([]);                 // 全部失败（机械无红项）
        expect(out.message.llmReview?.findings.length).toBe(1);      // LLM 审查
        expect(out.message.stdout).toContain("内存冒充数据库");
        expect(out.message.failureSignature).toBeTruthy();
    }, 60_000);

    test("机械绿 + 审查不可用 → needs_human，且不发 test_passed", async () => {
        const corr = "corr-norev";
        const out = await runTestAgentVerify(req(corr), stubOpts("sem-norev", stubBody(corr, {
            verdict: "pass", evidence: PASS_EVIDENCE,
            mechanicalVerdict: "pass", outcome: "llm_unavailable",
            reviewStatus: "LLM_REVIEW_UNAVAILABLE", reviewReason: "402 余额不足",
            llmReview: null, reviewSignals: [], blockingFindings: [], reviewAudit: { ...AUDIT, model: "" },
        })));
        expect(out.kind).toBe("needs_human");
        if (out.kind === "needs_human") {
            expect(out.reasons.join("|")).toContain("402");
            expect(out.result.mechanicalVerdict).toBe("pass");
        }
    }, 60_000);

    test("机械绿 + 审查 uncertain → needs_human（不伪装通过）", async () => {
        const corr = "corr-uncertain";
        const out = await runTestAgentVerify(req(corr), stubOpts("sem-unc", stubBody(corr, {
            verdict: "pass", evidence: PASS_EVIDENCE,
            mechanicalVerdict: "pass", outcome: "uncertain",
            reviewStatus: "ok",
            llmReview: { reviewVerdict: "uncertain", findings: [], confidence: "medium" },
            reviewSignals: [], blockingFindings: [], reviewAudit: AUDIT,
        })));
        expect(out.kind).toBe("needs_human");
        if (out.kind === "needs_human") expect(out.reasons.join("|")).toContain("uncertain");
    }, 60_000);

    test("verify 自报 outcome=pass 但 reviewStatus=disabled → 仍不通过（不轻信自报）", async () => {
        const corr = "corr-forged";
        const out = await runTestAgentVerify(req(corr), stubOpts("sem-forged", stubBody(corr, {
            verdict: "pass", evidence: PASS_EVIDENCE,
            mechanicalVerdict: "pass", outcome: "pass",          // ← 伪造/错报的"通过"
            reviewStatus: "disabled", llmReview: null,
            reviewSignals: [], blockingFindings: [], reviewAudit: null,
        })));
        expect(out.kind).toBe("needs_human");
        if (out.kind === "needs_human") expect(out.reasons.join("|")).toContain("未启用");
    }, 60_000);

    test("预扫信号里的 critical 也能阻断（模型没报也不行）", async () => {
        const corr = "corr-prescan";
        const out = await runTestAgentVerify(req(corr), stubOpts("sem-prescan", stubBody(corr, {
            verdict: "pass", evidence: PASS_EVIDENCE,
            mechanicalVerdict: "pass", outcome: "fail",
            reviewStatus: "ok",
            llmReview: { reviewVerdict: "pass", findings: [], confidence: "high" },   // 模型说没问题
            reviewSignals: [finding("critical", "PLACEHOLDER", "首页只回 OK")],        // 预扫抓到
            blockingFindings: [finding("critical", "PLACEHOLDER", "首页只回 OK")],
            reviewAudit: AUDIT,
        })));
        expect(out.kind).toBe("test_failure");
        if (out.kind === "test_failure") expect(out.message.blockingFindingTitles).toContain("critical/PLACEHOLDER 首页只回 OK");
    }, 60_000);

    test("机械失败 + 审查发现 → 三件套一起下发，红单与 findings 都不许少", async () => {
        const corr = "corr-both";
        const out = await runTestAgentVerify(req(corr), stubOpts("sem-both", stubBody(corr, {
            verdict: "fail",
            evidence: [PASS_EVIDENCE[0]!, FAIL_EVIDENCE],
            failure: FAIL_EVIDENCE,
            allFailures: [FAIL_EVIDENCE],
            mechanicalVerdict: "fail", outcome: "fail", outcomeReason: "机械验收失败",
            reviewStatus: "ok",
            llmReview: {
                reviewVerdict: "fail", confidence: "high",
                findings: [finding("major", "CONTRACT", "响应结构与业务语义不符"), finding("minor", "OTHER", "缺错误日志")],
            },
            reviewSignals: [finding("major", "PERSISTENCE", "内存冒充数据库")],
            reviewAudit: AUDIT,
        })));
        expect(out.kind).toBe("test_failure");
        if (out.kind !== "test_failure") return;
        expect(out.message.origin).toBe("mechanical");
        expect(out.message.exitCode).toBe(2);
        expect(out.message.stderr).toContain("ERR-B");
        expect(out.message.allFailures?.length).toBe(1);                    // 全部失败
        expect(out.message.mechanicalEvidence?.length).toBe(2);             // 机械证据
        expect(out.message.llmReview?.findings.length).toBe(2);             // LLM 审查（全量）
        expect(out.message.reviewSignals?.length).toBe(1);                  // 预扫信号也在
        expect(out.message.blockingFindingTitles?.length).toBe(2);          // 两条阻断项
        expect(out.message.reviewAudit?.promptHash).toBe("ph");             // 审计字段（落 Ledger 用）
        expect(out.message.reviewAudit?.tokenUsage?.totalTokens).toBe(3);
    }, 60_000);
});

// ============================================================
// 三、Developer 侧：修复提示词必须看到全部发现
// ============================================================

describe("Developer / 修复提示词", () => {
    test("语义失败消息进 Developer 后，findings 全量出现在修复提示词里", () => {
        const f = {
            type: "test_failure",
            messageId: "m", correlationId: "c", runId: "r", acceptanceHash: "h",
            projectId: "p", taskId: "t",
            category: "CONTRACT",
            origin: "llm_review",
            command: "(semantic-review)", args: [], cwd: ".",
            exitCode: 1, stdout: "", stderr: "",
            affectedFiles: [], failureSignature: "sig",
            reviewStatus: "ok",
            mechanicalEvidence: [
                { checkId: "ok-a", category: "COMPILE", command: "npm", args: ["run", "build"], cwd: "frontend", exitCode: 0, timedOut: false, startedAt: 1, finishedAt: 2, durationMs: 1, stdout: "MECH-STDOUT", stderr: "", failureSignature: "s1" },
            ],
            llmReview: {
                reviewVerdict: "fail", confidence: "high",
                findings: [
                    { severity: "critical", category: "PLACEHOLDER", title: "首页只回 OK", evidence: ["HTTP 200 /：body=OK"], recommendation: "实现真实首页" },
                    { severity: "major", category: "PERSISTENCE", title: "内存冒充数据库", evidence: ["store.js:3"], recommendation: "落 sqlite" },
                    { severity: "minor", category: "UI", title: "缺空态", evidence: [], recommendation: "补 empty 态" },
                ],
            },
        } satisfies TestFailure;
        const text = renderReviewFindings(f);
        expect(text).toContain("首页只回 OK");
        expect(text).toContain("内存冒充数据库");
        expect(text).toContain("缺空态");                     // minor 也必须到手上
        expect(text.split("\n").filter((l) => l.startsWith("#")).length).toBe(3);
    });
});
