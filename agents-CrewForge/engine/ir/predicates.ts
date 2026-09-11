// ============================================================
// predicates.ts —— 可执行谓词 + 极简 JSONPath（零 LLM 零依赖）
//
//   目的（M5）：让"验收"变成**机器能跑的东西**。
//   现状的病：CONTRACTS.md 是散文（p9 那份里主栈字段重复三次、与需求自相矛盾），
//   `expectedApisOf` 又靠正则戳 description 文本、格式一变就漏检且漏检即放行。
//   纪律：**自然语言只允许出现在 display* 字段；进验证器的必须是本文件的类型。**
// ============================================================

export type Predicate =
    | { op: "exists" }
    | { op: "equals"; value: unknown }
    | { op: "type"; value: "string" | "number" | "boolean" | "object" | "array" }
    | { op: "nonEmpty" }
    | { op: "oneOf"; values: unknown[] };

/** 支持 `$.a.b`、`$.a[0].b`、`a.b`（可省 `$.`）；不支持的语法返回 undefined（判定为失败而非静默通过） */
export function jsonPathGet(root: unknown, path: string): { found: boolean; value: unknown } {
    const clean = path.trim().replace(/^\$\.?/, "");
    if (!clean) return { found: true, value: root };
    let cur: unknown = root;
    for (const segRaw of clean.split(".")) {
        if (segRaw === "") continue;
        const idxMatch = /^(.*?)\[(\d+)\]$/.exec(segRaw);
        const key = idxMatch ? idxMatch[1]! : segRaw;
        const idx = idxMatch ? Number(idxMatch[2]) : null;
        if (key !== "") {
            if (cur === null || typeof cur !== "object") return { found: false, value: undefined };
            if (!(key in (cur as Record<string, unknown>))) return { found: false, value: undefined };
            cur = (cur as Record<string, unknown>)[key];
        }
        if (idx !== null) {
            if (!Array.isArray(cur) || idx >= cur.length) return { found: false, value: undefined };
            cur = cur[idx];
        }
    }
    return { found: true, value: cur };
}

function typeOf(v: unknown): Predicate extends never ? never : "string" | "number" | "boolean" | "object" | "array" | "null" | "undefined" {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    return typeof v as "string" | "number" | "boolean" | "object" | "undefined";
}

/** 求值：返回 null=通过；返回字符串=失败原因（可读中文，直接进报告） */
export function evaluatePredicate(actual: { found: boolean; value: unknown }, p: Predicate): string | null {
    switch (p.op) {
        case "exists":
            return actual.found ? null : "字段不存在";
        case "equals":
            return actual.found && JSON.stringify(actual.value) === JSON.stringify(p.value)
                ? null : `期望 ${JSON.stringify(p.value)}，实际 ${JSON.stringify(actual.value)}`;
        case "type": {
            if (!actual.found) return "字段不存在";
            const t = typeOf(actual.value);
            return t === p.value ? null : `期望类型 ${p.value}，实际 ${t}`;
        }
        case "nonEmpty": {
            if (!actual.found) return "字段不存在";
            const v = actual.value;
            const empty = v === "" || v === null || v === undefined
                || (Array.isArray(v) && v.length === 0)
                || (typeof v === "object" && !Array.isArray(v) && v !== null && Object.keys(v as object).length === 0);
            return empty ? "字段为空" : null;
        }
        case "oneOf":
            return p.values.some(v => JSON.stringify(v) === JSON.stringify(actual.value))
                ? null : `期望取值之一 ${JSON.stringify(p.values)}，实际 ${JSON.stringify(actual.value)}`;
        default:
            return `未知谓词 ${JSON.stringify(p)}`;
    }
}

/** 一组 jsonPath 断言 → 失败原因列表（空=全过） */
export function evaluateJsonPath(root: unknown, checks: Record<string, Predicate>): string[] {
    const failures: string[] = [];
    for (const [path, pred] of Object.entries(checks)) {
        const actual = jsonPathGet(root, path);
        const reason = evaluatePredicate(actual, pred);
        if (reason) failures.push(`${path}：${reason}`);
    }
    return failures;
}
