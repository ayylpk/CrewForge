// ============================================================
// scenarioSpec.ts —— 冻结场景规格 → 可执行验收 IR（★ 阶段 1 提交 3）
//
//   治的病（阶段 0 实测）：
//     · architect.ts 里 `successCode: 1` 是**硬编码**，而冻结需求的成功码是 200
//       → 后端按需求返回 code=200 也会被引擎自己的交付关判不通过
//     · baseline.ts 的 PROJECT_BASELINE.response.successCode 定义了一个"业务响应码"，
//       属于"引擎自造判据"——判据必须来自需求/场景规格
//
//   优先级（高 → 低）：
//     ① 冻结场景 expected.json（CF_ACCEPTANCE_SPEC 指向它）——阶段 1 的权威验收来源
//     ② 从项目需求原文里机械抠出的成功码（`"code":200` / `code：200`）
//     ③ 都没有 → **不发明判据**：不生成 $.code 断言，并把这件事记成 openQuestion
// ============================================================

import fs from "node:fs";
import type { Acceptance } from "./acceptance";
import type { Predicate } from "./predicates";

// ---------- 冻结场景规格（expected.json）形状 ----------

export interface SpecHttpAssertion {
    id: string;
    method: string;
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
    expectStatus: number;
    expectJsonPath?: Record<string, Predicate>;
    capture?: Record<string, string>;
    note?: string;
}

export interface SpecBuildExpectation { id: string; cwd: string; cmd: string; expectExitCode: number; required?: boolean }
export interface SpecStartExpectation { id: string; cwd: string; cmd: string; healthPath: string; expectReadyTimeoutMs: number; required?: boolean }
export interface SpecRenderAssertion { id: string; route: string; mustContainText: string[]; mustContainHtml: string[]; minTextLength: number }

export interface ScenarioSpec {
    schemaVersion: string;
    id: string;
    title: string;
    kind: string;
    expectFailure?: boolean;
    stack?: Record<string, string>;
    artifactLayout?: {
        frontendDir: string; backendDir: string;
        frontendEntryCandidates?: string[]; backendJarDir?: string;
    };
    buildExpectations?: SpecBuildExpectation[];
    startExpectations?: SpecStartExpectation[];
    httpAssertions: SpecHttpAssertion[];
    renderAssertions?: SpecRenderAssertion[];
    honesty?: Record<string, unknown>;
}

export function loadScenarioSpec(file: string): ScenarioSpec {
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as ScenarioSpec;
    if (!parsed || !Array.isArray(parsed.httpAssertions)) {
        throw new Error(`场景规格非法（缺 httpAssertions 数组）：${file}`);
    }
    return parsed;
}

/** 环境变量指到的活动场景规格（未配置=null，行为与旧版一致） */
export function activeScenarioSpec(): { spec: ScenarioSpec; file: string } | null {
    const file = process.env.CF_ACCEPTANCE_SPEC?.trim() || process.env.ACCEPTANCE_SPEC?.trim();
    if (!file) return null;
    if (!fs.existsSync(file)) {
        console.warn(`[scenarioSpec] CF_ACCEPTANCE_SPEC 指向的文件不存在：${file}（按未配置处理）`);
        return null;
    }
    try {
        return { spec: loadScenarioSpec(file), file };
    } catch (e) {
        console.warn(`[scenarioSpec] 场景规格解析失败：${(e as Error).message}`);
        return null;
    }
}

/** 场景规格 → 验收 IR（逐条转换，不增不减；capture 原样带过去） */
export function acceptanceFromScenarioSpec(spec: ScenarioSpec): { cases: Acceptance[]; skipped: string[] } {
    const cases: Acceptance[] = [];
    const skipped: string[] = [];
    for (const a of spec.httpAssertions) {
        const method = String(a.method ?? "").trim().toUpperCase();
        const path = String(a.path ?? "").trim();
        if (!a.id || !method || !path.startsWith("/")) {
            skipped.push(`${a.id || "(无 id)"}：缺 method/path，无法生成可执行验收`);
            continue;
        }
        cases.push({
            kind: "http",
            id: a.id,
            request: {
                method, path,
                ...(a.body !== undefined ? { body: a.body } : {}),
                ...(a.headers ? { headers: a.headers } : {}),
            },
            expect: {
                status: a.expectStatus,
                ...(a.expectJsonPath && Object.keys(a.expectJsonPath).length > 0 ? { jsonPath: a.expectJsonPath } : {}),
            },
            ...(a.capture ? { capture: a.capture } : {}),
            display: a.note ?? `${method} ${path}`,
        });
    }
    return { cases, skipped };
}

// ---------- 从需求原文解析成功码（②级来源） ----------

export interface ResponseCodeResolution {
    successCode: number | null;
    source: "scenario-spec" | "requirement" | "unknown";
    evidence: string;
}

/**
 * 机械解析需求原文里的统一响应体成功码。
 * 只认**明确的 JSON 字段写法**，不做语义猜测：
 *   `{"code":200, ...}` / `"code": 200` / `code：200` / `code=200`
 * 解析不到就返回 null —— 由调用方记 openQuestion，**绝不回落到引擎内置默认值**。
 */
export function resolveSuccessCodeFromRequirement(text: string | null | undefined): ResponseCodeResolution {
    if (!text || !text.trim()) {
        return { successCode: null, source: "unknown", evidence: "需求原文为空，无法判定成功码" };
    }
    const patterns: RegExp[] = [
        /["']code["']\s*[:：=]\s*(\d{2,4})/i,
        /\bcode\s*[:：=]\s*(\d{2,4})\b/i,
        /状态码\s*[:：=]?\s*(\d{3})/,
    ];
    for (const re of patterns) {
        const m = re.exec(text);
        if (m?.[1]) {
            const n = Number(m[1]);
            if (Number.isFinite(n)) {
                return { successCode: n, source: "requirement", evidence: `需求原文命中「${m[0].trim()}」` };
            }
        }
    }
    return { successCode: null, source: "unknown", evidence: "需求原文未写明统一响应成功码（不发明判据，记 openQuestion）" };
}

/** 统一解析入口：场景规格优先，其次需求原文 */
export function resolveAcceptanceCode(requirementText: string | null | undefined): ResponseCodeResolution {
    const active = activeScenarioSpec();
    if (active) {
        for (const a of active.spec.httpAssertions) {
            const code = a.expectJsonPath?.["code"] ?? a.expectJsonPath?.["$.code"];
            if (code && code.op === "equals" && typeof code.value === "number") {
                return {
                    successCode: code.value,
                    source: "scenario-spec",
                    evidence: `场景规格 ${active.spec.id} 的 ${a.id} 断言 code==${code.value}（文件 ${active.file}）`,
                };
            }
        }
        return { successCode: null, source: "unknown", evidence: `场景规格 ${active.spec.id} 未声明 code 断言` };
    }
    return resolveSuccessCodeFromRequirement(requirementText);
}
