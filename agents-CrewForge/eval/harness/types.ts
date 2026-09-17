// ============================================================
// eval/harness/types.ts —— 阶段 0 基线的稳定数据契约
//
//   铁律（对齐主计划不变量 1/2）：
//     · 任何一个 status="pass" 都必须绑定【真实命令 + 退出码】，或【真实 HTTP 状态码 + 逐字段断言】
//     · 判定不出来的一律 status="blocked"（缺工具/缺产物/沙箱拒绝），**绝不折算成 pass**
//     · 本文件只放类型与"通过绑定"校验，不放 IO
// ============================================================

import type { Predicate } from "../../engine/ir/predicates";

export type CheckKind = "pipeline" | "build" | "boot" | "http" | "render" | "static";
export type CheckStatus = "pass" | "fail" | "blocked" | "skipped";

export interface JsonAssertionResult {
    path: string;
    op: string;
    ok: boolean;
    detail: string;
}

/** 一条可复核的检查记录；字段名即报告页字段，别随手改（JSON schema 稳定） */
export interface CheckResult {
    id: string;
    kind: CheckKind;
    status: CheckStatus;
    /** 真实执行的命令（pass 时必填；blocked/fail 也尽量填） */
    command: string | null;
    cwd: string | null;
    exitCode: number | null;
    httpStatus: number | null;
    expectStatus: number | null;
    jsonAssertions: JsonAssertionResult[];
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    logFile: string | null;
    /** 一句话结论（人读） */
    detail: string;
    /** 证据摘录（stdout/stderr 尾部，机器留档） */
    evidence: string;
}

/** 通过绑定校验：违反即抛——这是"静态 grep / LLM 文字不得单独产生 pass"的代码级闸门 */
export function assertPassIsBound(c: CheckResult): void {
    if (c.status !== "pass") return;
    if (c.kind === "http") {
        if (c.httpStatus == null || c.expectStatus == null || c.httpStatus !== c.expectStatus) {
            throw new Error(`[baseline] 非法 pass：${c.id} 是 http 检查但没有真实匹配的状态码（httpStatus=${c.httpStatus} expect=${c.expectStatus}）`);
        }
        if (c.jsonAssertions.some(a => !a.ok)) {
            throw new Error(`[baseline] 非法 pass：${c.id} 存在未通过的字段断言`);
        }
        return;
    }
    if (c.kind === "render") {
        // 渲染判定的"命令 + 退出码"来自真实 headless 浏览器进程
        if (!c.command || c.exitCode == null || c.exitCode !== 0) {
            throw new Error(`[baseline] 非法 pass：${c.id} 是渲染检查但没有真实命令/退出码`);
        }
        return;
    }
    if (!c.command || !c.command.trim()) {
        throw new Error(`[baseline] 非法 pass：${c.id} 没有绑定任何命令`);
    }
    if (c.exitCode == null || c.exitCode !== 0) {
        throw new Error(`[baseline] 非法 pass：${c.id} 的退出码不是 0（exitCode=${c.exitCode}）`);
    }
}

export function assertAllPassesBound(checks: CheckResult[]): void {
    for (const c of checks) assertPassIsBound(c);
}

// ---------- 场景（冻结输入 + 机器可比对的期望） ----------

export interface ScenarioHttpAssertion {
    id: string;
    method: string;
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
    expectStatus: number;
    expectJsonPath: Record<string, Predicate>;
    /** 从响应里抠变量供后续断言用，如 { noteId: "data.id" } */
    capture?: Record<string, string>;
    note?: string;
}

export interface ScenarioRenderAssertion {
    id: string;
    route: string;
    mustContainText: string[];
    mustContainHtml: string[];
    minTextLength: number;
}

export interface ScenarioBuildExpectation {
    id: string;
    cwd: string;
    cmd: string;
    expectExitCode: number;
    required?: boolean;
    /** 工具链提示：产物（pom.xml/package.json）缺失时用它判分支；产物存在时产物说了算 */
    runtime?: "java" | "node";
}

export interface ScenarioStartExpectation {
    id: string;
    cwd: string;
    cmd: string;
    /** 启动方式：java=找 jar 用 java -jar（默认，兼容 s1~s3）；node=在 cwd 下 npm start */
    runtime?: "java" | "node";
    healthPath: string;
    expectReadyTimeoutMs: number;
    required?: boolean;
}

export interface ScenarioArtifactLayout {
    frontendDir: string;
    backendDir: string;
    frontendEntryCandidates: string[];
    backendJarDir: string;
}

export interface Scenario {
    schemaVersion: string;
    id: string;
    title: string;
    kind: string;
    expectFailure: boolean;
    frozenAt: string;
    inputFile: string;
    stack: Record<string, string>;
    contractConflict?: Record<string, string>;
    artifactLayout: ScenarioArtifactLayout;
    buildExpectations: ScenarioBuildExpectation[];
    startExpectations: ScenarioStartExpectation[];
    httpAssertions: ScenarioHttpAssertion[];
    renderAssertions: ScenarioRenderAssertion[];
    honesty: {
        mustNotClaimVerifiedUnlessAllAssertionsPass?: boolean;
        mustFailLoudly?: boolean;
        note?: string;
    };
}

// ---------- 结果 ----------

export interface PipelineTokenUsage {
    available: boolean;
    note: string;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
}

export interface PipelineRunRecord {
    projectId: number;
    command: string;
    cwd: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    exitCode: number | null;
    timedOut: boolean;
    /** 非自然退出时的原因：manual=人工终止（未自然收口）；null=进程自己跑完 */
    termination: "manual" | "timeout" | null;
    stdoutFile: string;
    stderrFile: string;
    stdoutBytes: number;
    stdoutTail: string;
    stderrTail: string;
    /** 子系统上报的重试次数（当前系统无此计数 → null + 说明，不许编造 0） */
    retries: number | null;
    tokenUsage: PipelineTokenUsage;
    dbFinalStatus: string | null;
    dbTasks: { total: number; done: number; failed: number; todo: number; running: number };
    verifyReportFile: string | null;
    verifyOutcome: string | null;
    verifySummary: string | null;
}

export interface ArtifactInventory {
    dir: string;
    exists: boolean;
    fileCount: number;
    byExt: Record<string, number>;
    files: string[];
    /** 顶层目录约定（p1 的"四套目录"就是靠这个看出来的） */
    topLevelDirs: string[];
}

export interface ScenarioVerdict {
    /** pass=全部必需检查通过；fail=有真实失败；blocked=环境缺失导致无法判定；partial=部分通过且存在失败 */
    overall: "pass" | "fail" | "blocked" | "partial";
    passed: string[];
    failed: string[];
    blocked: { id: string; reason: string }[];
    skipped: string[];
    /** 系统自我申报 */
    systemClaimedStatus: string | null;
    systemClaimedVerified: boolean;
    /** 有真实断言失败，但系统报 done+verified → 假通过 */
    fakePass: boolean;
    /** 系统报 done 但显式未验证（诚实但不等于通过） */
    doneButUnverified: boolean;
    reason: string;
}

export interface ScenarioResult {
    schemaVersion: "crewforge.eval.result/1";
    scenarioId: string;
    title: string;
    kind: string;
    expectFailure: boolean;
    ranAt: string;
    inputFile: string;
    expectedFile: string;
    pipeline: PipelineRunRecord;
    artifacts: ArtifactInventory;
    checks: CheckResult[];
    verdict: ScenarioVerdict;
}

// ---------- 环境 ----------

export interface ToolProbe {
    name: string;
    command: string;
    found: boolean;
    path: string | null;
    exitCode: number | null;
    versionLine: string | null;
    ok: boolean;
    note: string;
}

export interface ServiceProbe {
    name: string;
    probe: string;
    reachable: boolean | null;
    exitCode: number | null;
    evidence: string;
    note: string;
}

export interface EnvironmentReport {
    schemaVersion: "crewforge.eval.env/1";
    probedAt: string;
    cwd: string;
    platform: string;
    tools: ToolProbe[];
    services: ServiceProbe[];
    llm: {
        endpoint: string | null;
        model: string | null;
        reachable: boolean;
        httpStatus: number | null;
        evidence: string;
    };
    /** 环境缺口：明确写出缺什么、影响哪些判定（绝不用它换 pass） */
    limitations: { id: string; missing: string; impact: string; evidence: string }[];
}
