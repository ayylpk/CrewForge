// ============================================================
// acceptance.ts —— 可执行验收 IR（M5）
//
//   三种形态，没有第四种；**自然语言只能进 display***：
//     http    —— 打真实接口，断言状态码 + JSON 字段（谓词）
//     command —— 跑一条命令，断言退出码
//     testFile—— 指向仓库里一个真实测试文件，由引擎负责跑
//
//   校验发生在**规划期**：非法验收（纯自然语言、http 缺 expect）必须当场拒收，
//   而不是等到验证期才发现"这条验收根本没法执行"。
// ============================================================

import { z } from "zod";
import type { Predicate } from "./predicates";
import { evaluateJsonPath } from "./predicates";

export const PredicateSchema = z.discriminatedUnion("op", [
    z.object({ op: z.literal("exists") }),
    z.object({ op: z.literal("equals"), value: z.unknown() }),
    z.object({ op: z.literal("type"), value: z.enum(["string", "number", "boolean", "object", "array"]) }),
    z.object({ op: z.literal("nonEmpty") }),
    z.object({ op: z.literal("oneOf"), values: z.array(z.unknown()) }),
]);

export const AcceptanceSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("http"),
        id: z.string().min(1),
        request: z.object({
            method: z.string().min(1),
            path: z.string().min(1),
            body: z.unknown().optional(),
            query: z.record(z.string(), z.string()).optional(),
            headers: z.record(z.string(), z.string()).optional(),
        }),
        expect: z.object({
            status: z.number().int(),
            jsonPath: z.record(z.string(), PredicateSchema).optional(),
        }),
        /**
         * ★ 阶段 1 提交 3：从响应里抠变量供后续断言使用（如 { noteId: "data.id" }），
         * 路径/请求头/请求体里的 `{name}` 会被替换成上一次捕获到的值。
         * 没有它，"删除后再 GET 必须 404"这类**跨请求**断言无法机器执行。
         */
        capture: z.record(z.string(), z.string()).optional(),
        /** 给人看的说明（不参与判定） */
        display: z.string().optional(),
    }),
    z.object({
        kind: z.literal("command"),
        id: z.string().min(1),
        run: z.string().min(1),
        expect: z.object({ exitCode: z.number().int() }),
        display: z.string().optional(),
    }),
    z.object({
        kind: z.literal("testFile"),
        id: z.string().min(1),
        path: z.string().min(1),
        display: z.string().optional(),
    }),
]);

export type Acceptance = z.infer<typeof AcceptanceSchema>;
export type HttpAcceptance = Extract<Acceptance, { kind: "http" }>;
export type CommandAcceptance = Extract<Acceptance, { kind: "command" }>;
export type TestFileAcceptance = Extract<Acceptance, { kind: "testFile" }>;

export interface AcceptanceValidation {
    ok: boolean;
    value: Acceptance[];
    /** 拒收原因（可读；直接把原文贴给规划器让它重出） */
    errors: string[];
    /** 被丢弃的纯自然语言条目（用于在报告里显式说明"这些没进判定"） */
    rejectedDisplayOnly: string[];
}

/** 疑似"纯自然语言验收"：字符串、或没有 kind 的对象 */
function isFreeText(v: unknown): boolean {
    if (typeof v === "string") return true;
    if (!v || typeof v !== "object") return true;
    const kind = (v as Record<string, unknown>).kind;
    return kind !== "http" && kind !== "command" && kind !== "testFile";
}

/**
 * 校验并归一验收清单。
 * ★ 纯自然语言条目**不报错**（规划器常写一句人话），但会进 rejectedDisplayOnly 并在报告里显式列出——
 *   既不假装它被验证了，也不因为一句人话整包拒收。
 */
export function validateAcceptance(raw: unknown): AcceptanceValidation {
    const errors: string[] = [];
    const value: Acceptance[] = [];
    const rejectedDisplayOnly: string[] = [];
    if (!Array.isArray(raw)) {
        return { ok: false, value: [], errors: ["acceptance 必须是数组"], rejectedDisplayOnly: [] };
    }
    raw.forEach((item, i) => {
        if (isFreeText(item)) {
            rejectedDisplayOnly.push(typeof item === "string" ? item.slice(0, 120) : JSON.stringify(item).slice(0, 120));
            return;
        }
        const parsed = AcceptanceSchema.safeParse(item);
        if (!parsed.success) {
            const issues = parsed.error.issues.map(x => `${x.path.join(".") || "(root)"}: ${x.message}`).join("; ");
            errors.push(`第 ${i + 1} 条验收非法：${issues}`);
            return;
        }
        value.push(parsed.data as Acceptance);
    });
    const ids = new Set<string>();
    for (const a of value) {
        if (ids.has(a.id)) errors.push(`验收 id 重复：${a.id}`);
        ids.add(a.id);
    }
    return { ok: errors.length === 0 && value.length > 0, value, errors, rejectedDisplayOnly };
}

/** 判定入口：跑一条 http 验收（给定响应就能算，纯函数——便于单测与复用） */
export function judgeHttpAcceptance(
    a: HttpAcceptance,
    res: { status: number; json: unknown },
): { passed: boolean; reason: string } {
    if (res.status !== a.expect.status) {
        return { passed: false, reason: `${a.request.method} ${a.request.path} 期望状态 ${a.expect.status}，实际 ${res.status}` };
    }
    if (a.expect.jsonPath && Object.keys(a.expect.jsonPath).length > 0) {
        const failures = evaluateJsonPath(res.json, a.expect.jsonPath as Record<string, Predicate>);
        if (failures.length > 0) return { passed: false, reason: `${a.request.method} ${a.request.path} 字段断言失败：${failures.join("；")}` };
    }
    return { passed: true, reason: "通过" };
}
