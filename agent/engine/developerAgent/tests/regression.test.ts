// ============================================================
// tests/regression.test.ts —— 回归冻结的口径
//
//   守住的东西：**修复动作弄坏已通过项**必须被点名（s4 死因），
//   而"首次预演没有基线"不许被当成回归（误报会让模型去回退本来正确的东西）。
// ============================================================

import { describe, expect, it } from "bun:test";
import { diffCriteria, renderRegressionWarning, summarizeCriteriaDiff } from "../regression";
import type { CriteriaMap } from "../regression";

describe("regression / 逐条比对", () => {
    it("首次预演（没有基线）→ 不算回归，只报当轮失败", () => {
        const d = diffCriteria(null, { a: "pass", b: "fail", c: "unevaluable" });
        expect(d.firstRun).toBe(true);
        expect(d.regressed).toEqual([]);
        expect(d.stillFailing).toEqual(["b"]);
        expect(renderRegressionWarning(d)).toBe("");   // 无回归 → 不制造噪音
    });

    it("★ 上次通过、这次失败 = 回归（必须点名）", () => {
        const prev: CriteriaMap = { "http:POST:/api/notes": "pass", "http:GET:/api/notes": "pass" };
        const next: CriteriaMap = { "http:POST:/api/notes": "fail", "http:GET:/api/notes": "pass" };
        const d = diffCriteria(prev, next);
        expect(d.regressed).toEqual(["http:POST:/api/notes"]);
        expect(d.fixed).toEqual([]);
        expect(d.stillFailing).toEqual([]);
    });

    it("上次失败、这次通过 = 进展（如实肯定，防止模型以为没进展而乱换方向）", () => {
        const d = diffCriteria({ a: "fail", b: "fail" }, { a: "pass", b: "fail" });
        expect(d.fixed).toEqual(["a"]);
        expect(d.stillFailing).toEqual(["b"]);
        expect(d.regressed).toEqual([]);
    });

    it("不可判定也算'没通过'：从 pass 掉到 unevaluable 同样算回归", () => {
        const d = diffCriteria({ a: "pass" }, { a: "unevaluable" });
        expect(d.regressed).toEqual(["a"]);
    });

    it("新出现的判据不算回归；消失的判据单列（判据被改是架构师侧的事）", () => {
        const d = diffCriteria({ a: "pass", gone: "fail" }, { a: "pass", fresh: "fail" });
        expect(d.appeared).toEqual(["fresh"]);
        expect(d.disappeared).toEqual(["gone"]);
        expect(d.regressed).toEqual([]);
    });
});

describe("regression / 给模型的提示块", () => {
    it("有回归时点明三件事：是哪几条、几乎一定是本轮改动、先回退/收窄", () => {
        const d = diffCriteria({ x: "pass", y: "pass" }, { x: "fail", y: "pass" });
        const block = renderRegressionWarning(d);
        expect(block).toContain("回归警告");
        expect(block).toContain("x");
        expect(block).toContain("上一轮是通过的");
        expect(block).toContain("回退或收窄");
        // 明确**禁止**重写方向——那正是 s4 越修越乱的原因（"不要重写这些判据对应的功能"）
        expect(block).toContain("不要重写");
    });

    it("摘要可审计（回归/新修好/仍在失败 + 判据增减）", () => {
        const d = diffCriteria({ a: "pass", b: "fail" }, { a: "fail", b: "pass", c: "fail" });
        const s = summarizeCriteriaDiff(d);
        expect(s).toContain("回归 1");
        expect(s).toContain("新修好 1");
        expect(s).toContain("仍在失败 0");
        expect(s).toContain("新增判据 1");
    });
});
