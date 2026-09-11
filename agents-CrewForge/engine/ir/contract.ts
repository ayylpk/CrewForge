// ============================================================
// contract.ts —— 契约 IR + 渲染器（M5）
//
//   现状的病：契约是 LLM 生成的散文 markdown（CONTRACTS.md），**可被静默旁路**
//   （contracts.ts 里 catch 后 return null，全员按"无契约"跑）；p9 那份里主栈字段重复三次、
//   还与同一文档中 PM 亲答的"9 页面 + TDesign"自相矛盾。
//
//   现在：契约是**类型化 IR**（endpoints + 请求/响应字段），并由它机械渲染出
//     ① 可执行验收（http 断言）② 可跑测试脚本 ③ 前端请求桩（只 import 唯一封装路径）④ 文档
//   一份 IR、多个消费者 —— 前后端共享同一份定义，而不是各自实现后靠比对。
// ============================================================

import { z } from "zod";
import type { Acceptance } from "./acceptance";
import { evaluateJsonPath } from "./predicates";

export const FieldSchema = z.object({
    name: z.string().min(1),
    type: z.enum(["string", "number", "boolean", "object", "array"]),
    required: z.boolean(),
    desc: z.string().optional(),
});

export const EndpointSchema = z.object({
    method: z.string().min(1),
    /** 以 / 开头的业务路径（不含 api 前缀），如 /auth/login */
    path: z.string().min(1),
    purpose: z.string().optional(),
    requestFields: z.array(FieldSchema).optional(),
    responseFields: z.array(FieldSchema).optional(),
});

export const ContractSchema = z.object({
    endpoints: z.array(EndpointSchema).min(1),
});

export type Contract = z.infer<typeof ContractSchema>;
export type Endpoint = z.infer<typeof EndpointSchema>;
export type Field = z.infer<typeof FieldSchema>;

export interface ContractValidation { ok: boolean; value: Contract | null; errors: string[] }

export function validateContract(raw: unknown): ContractValidation {
    const parsed = ContractSchema.safeParse(raw);
    if (!parsed.success) {
        return { ok: false, value: null, errors: parsed.error.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`) };
    }
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const e of parsed.data.endpoints) {
        const key = `${e.method.toUpperCase()} ${e.path}`;
        if (seen.has(key)) errors.push(`接口重复：${key}`);
        seen.add(key);
        if (!e.path.startsWith("/")) errors.push(`${key}：path 必须以 / 开头`);
    }
    return { ok: errors.length === 0, value: parsed.data, errors };
}

export interface AcceptanceFromContractOpts {
    /** API 前缀（来自基线，默认 /api） */
    apiPrefix?: string;
    /** 响应包装：成功码（来自基线）；给了就断言 $.code */
    successCode?: number;
    /** 业务字段所在路径（默认 $.data） */
    dataPath?: string;
}

/**
 * 契约 → 可执行验收。每个接口生成一条 http 断言：
 *   状态码 200 + （可选）$.code == successCode + 每个响应字段的**类型**断言。
 * 只断言"契约自己声明过的字段"，不发明不存在的期望（避免自造假失败）。
 */
export function acceptanceFromContract(c: Contract, opts: AcceptanceFromContractOpts = {}): Acceptance[] {
    const prefix = (opts.apiPrefix ?? "/api").replace(/\/$/, "");
    const dataPath = opts.dataPath ?? "$.data";
    return c.endpoints.map((e, i) => {
        const method = e.method.toUpperCase();
        const fullPath = `${prefix}${e.path.startsWith("/") ? e.path : `/${e.path}`}`;
        const jsonPath: Record<string, { op: "type"; value: Field["type"] } | { op: "equals"; value: unknown }> = {};
        if (opts.successCode != null) jsonPath["$.code"] = { op: "equals", value: opts.successCode };
        for (const f of e.responseFields ?? []) {
            jsonPath[`${dataPath}.${f.name}`] = { op: "type", value: f.type };
        }
        return {
            kind: "http",
            id: `${method}-${e.path.replace(/[^\w]+/g, "-")}-${i + 1}`,
            request: { method, path: fullPath },
            expect: { status: 200, ...(Object.keys(jsonPath).length > 0 ? { jsonPath } : {}) },
            display: e.purpose ?? `${method} ${fullPath}`,
        };
    });
}

/** 前端请求桩：只 import 唯一封装路径（杜绝幽灵 wrapper），函数名由路径机械生成 */
export function renderClientStub(c: Contract, requestPath: string): string {
    const lines: string[] = [
        `// 由 CrewForge 契约机械生成（勿手改）：契约一变，重新生成`,
        `import request from "${requestPath.replace(/^frontend\/src\//, "../").replace(/\.ts$/, "")}";`,
        "",
    ];
    for (const e of c.endpoints) {
        const method = e.method.toLowerCase();
        const name = e.path.replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "");
        const params = (e.requestFields ?? []).map(f => `${f.name}${f.required ? "" : "?"}: ${tsType(f.type)}`).join(", ");
        const bodyArg = (e.requestFields ?? []).length > 0 ? `, { ${(e.requestFields ?? []).map(f => f.name).join(", ")} }` : "";
        lines.push(`/** ${e.purpose ?? `${e.method} ${e.path}`} */`);
        lines.push(`export const ${method}${name} = (${params}) => request.${method}("${e.path}"${bodyArg});`);
        lines.push("");
    }
    return lines.join("\n");
}

function tsType(t: Field["type"]): string {
    switch (t) {
        case "string": return "string";
        case "number": return "number";
        case "boolean": return "boolean";
        case "array": return "unknown[]";
        default: return "Record<string, unknown>";
    }
}

/** 契约 → 契约文档（人读；**不进判据**） */
export function renderContractDoc(c: Contract, apiPrefix = "/api"): string {
    const rows = c.endpoints.map(e => {
        const req = (e.requestFields ?? []).map(f => `${f.name}:${f.type}${f.required ? "" : "?"}`).join(", ") || "-";
        const res = (e.responseFields ?? []).map(f => `${f.name}:${f.type}`).join(", ") || "-";
        return `| ${e.method.toUpperCase()} ${apiPrefix}${e.path} | ${e.purpose ?? ""} | ${req} | ${res} |`;
    });
    return [
        "# 接口契约（由 CrewForge 契约 IR 机械生成，人读用，不参与判定）",
        "",
        "| 接口 | 用途 | 请求字段 | 响应字段（在 $.data 下） |",
        "|---|---|---|---|",
        ...rows,
        "",
    ].join("\n");
}

/**
 * 验收清单 → **可直接跑的契约测试脚本**（自包含，只用 fetch）。
 * 引擎把它写进产物树再执行；退出码 0=全过，1=有失败，2=脚本自身错。
 */
export function renderAcceptanceRunner(cases: Acceptance[], title = "contract"): string {
    return `// 由 CrewForge 验收 IR 机械生成（勿手改）—— ${title}
// 用法：BASE_URL=http://localhost:8080 bun run <this file>
const BASE = process.env.BASE_URL || "http://localhost:8080";
const CASES = ${JSON.stringify(cases, null, 2)};

function get(root, path) {
  const clean = String(path).trim().replace(/^\\$\\.?/, "");
  if (!clean) return { found: true, value: root };
  let cur = root;
  for (const segRaw of clean.split(".")) {
    if (!segRaw) continue;
    const m = /^(.*?)\\[(\\d+)\\]$/.exec(segRaw);
    const key = m ? m[1] : segRaw;
    const idx = m ? Number(m[2]) : null;
    if (key !== "") {
      if (cur === null || typeof cur !== "object" || !(key in cur)) return { found: false, value: undefined };
      cur = cur[key];
    }
    if (idx !== null) {
      if (!Array.isArray(cur) || idx >= cur.length) return { found: false, value: undefined };
      cur = cur[idx];
    }
  }
  return { found: true, value: cur };
}

function evaluate(actual, p) {
  if (p.op === "exists") return actual.found ? null : "字段不存在";
  if (p.op === "equals") return actual.found && JSON.stringify(actual.value) === JSON.stringify(p.value) ? null : "期望 " + JSON.stringify(p.value) + "，实际 " + JSON.stringify(actual.value);
  if (p.op === "type") {
    if (!actual.found) return "字段不存在";
    const v = actual.value;
    const t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
    return t === p.value ? null : "期望类型 " + p.value + "，实际 " + t;
  }
  if (p.op === "nonEmpty") {
    if (!actual.found) return "字段不存在";
    const v = actual.value;
    const empty = v === "" || v === null || v === undefined || (Array.isArray(v) && v.length === 0)
      || (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
    return empty ? "字段为空" : null;
  }
  if (p.op === "oneOf") return p.values.some((x) => JSON.stringify(x) === JSON.stringify(actual.value)) ? null : "取值不在允许集合内";
  return "未知谓词";
}

let failed = 0;
for (const c of CASES) {
  if (c.kind !== "http") { console.log("[skip] " + c.kind + " " + c.id); continue; }
  const url = BASE + c.request.path;
  let status = 0, json = null, err = null;
  try {
    const res = await fetch(url, {
      method: c.request.method,
      headers: { "Content-Type": "application/json", ...(c.request.headers || {}) },
      body: c.request.body === undefined ? undefined : JSON.stringify(c.request.body),
    });
    status = res.status;
    const text = await res.text();
    try { json = JSON.parse(text); } catch { json = { __raw: text.slice(0, 400) }; }
  } catch (e) { err = String(e && e.message || e); }

  const problems = [];
  if (err) problems.push("请求失败：" + err);
  else {
    if (status !== c.expect.status) problems.push("期望状态 " + c.expect.status + "，实际 " + status);
    for (const [p, pred] of Object.entries(c.expect.jsonPath || {})) {
      const reason = evaluate(get(json, p), pred);
      if (reason) problems.push(p + "：" + reason);
    }
  }
  if (problems.length) { failed++; console.log("[FAIL] " + c.id + " -> " + problems.join(" | ")); }
  else console.log("[PASS] " + c.id);
}
console.log("\\n契约测试：失败 " + failed + " / 共 " + CASES.length);
process.exit(failed > 0 ? 1 : 0);
`;
}

/** 复用：把 jsonPath 断言直接用在任意响身上（引擎内部用） */
export function checkResponseFields(json: unknown, checks: Record<string, import("./predicates").Predicate>): string[] {
    return evaluateJsonPath(json, checks);
}

// ============================================================
// 从**结构化任务**生成验收（★ 不碰文本正则）
//
//   背景：旧实现用 `expectedApisOf` 正则去戳 task.description 文本行（`- POST /api/x`），
//   格式一变就漏检、而漏检即放行。ExecTask 本来就带 method/path 字段，直接读字段即可。
// ============================================================

export interface TaskLike {
    id: string;
    layer: "backend" | "frontend";
    method: string;
    path: string;
    title?: string;
}

export interface AcceptanceFromTasksOpts {
    apiPrefix?: string;
    /** 期望状态码（默认 200） */
    expectStatus?: number;
    /** 成功码断言（来自基线；给了就断言 $.code） */
    successCode?: number;
}

/**
 * 每个后端任务 → 一条 http 验收：断言状态码（+ 成功码）。
 * 前端任务不产生验收（它由渲染审与契约测试的响应字段覆盖）。
 * method/path 为空的任务被跳过并**如实计数**（不发明验收）。
 */
export function acceptanceFromTasks(tasks: TaskLike[], opts: AcceptanceFromTasksOpts = {}): { cases: Acceptance[]; skipped: string[] } {
    const prefix = (opts.apiPrefix ?? "/api").replace(/\/$/, "");
    const status = opts.expectStatus ?? 200;
    const cases: Acceptance[] = [];
    const skipped: string[] = [];
    const seen = new Set<string>();
    for (const t of tasks) {
        if (t.layer !== "backend") continue;
        const method = (t.method ?? "").trim().toUpperCase();
        const rawPath = (t.path ?? "").trim();
        if (!method || !rawPath || !rawPath.startsWith("/")) {
            skipped.push(`${t.id}${t.title ? `（${t.title}）` : ""}：缺 method/path，无法生成验收`);
            continue;
        }
        const full = rawPath.startsWith(prefix) ? rawPath : `${prefix}${rawPath}`;
        const key = `${method} ${full}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const jsonPath: Record<string, { op: "equals"; value: unknown }> = {};
        if (opts.successCode != null) jsonPath["$.code"] = { op: "equals", value: opts.successCode };
        cases.push({
            kind: "http",
            id: `${method}-${full.replace(/[^\w]+/g, "-")}`,
            request: { method, path: full },
            expect: { status, ...(Object.keys(jsonPath).length ? { jsonPath } : {}) },
            display: t.title ?? `${method} ${full}`,
        });
    }
    return { cases, skipped };
}
