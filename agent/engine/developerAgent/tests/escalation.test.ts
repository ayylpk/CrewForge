// ============================================================
// tests/escalation.test.ts —— 求助内核的确定性口径
//
//   为什么这些用例重要：escalation.ts 是"该问人时一定会问"的**唯一保证**。
//   它是纯函数，所以能用零 LLM 的断言把策略钉死：
//     · 什么条件下必须问（顺序即优先级）
//     · 问出来的题必须是"人能决策的题"（四段模板 + 选项）
//     · 答案必须被确定性地翻成 continue / narrow / stop
//     · 问人必须有界（不许变成无限续命）
// ============================================================

import { describe, expect, it } from "bun:test";
import {
    ESCALATION_OPTIONS, MAX_ESCALATIONS_PER_TASK, SAME_FAILURE_LIMIT,
    buildEscalationQuestion, describeEscalation, parseEscalationAnswer, shouldEscalate,
} from "../escalation";
import type { EscalationSnapshot } from "../escalation";

const base = (patch: Partial<EscalationSnapshot> = {}): EscalationSnapshot => ({
    taskId: "t1", status: "implementing", workItem: "w2", escalationsUsed: 0, ...patch,
});

describe("escalation / 何时必须问人（代码判定，不靠模型自觉）", () => {
    it("什么都没触发 → 不问（不拿无效问题打扰人）", () => {
        expect(shouldEscalate(base())).toBeNull();
    });

    it("环境缺口优先于一切（缺密钥/端口/DB：改代码解决不了）", () => {
        const t = shouldEscalate(base({
            envGaps: ["模型凭据未配置"], sameFailureStreak: SAME_FAILURE_LIMIT,
            budgetExhausted: true, unfinishedUnits: 3,
        }));
        expect(t?.reason).toBe("NEEDS_ENV");
        expect(t?.diagnosis).toContain("环境缺口");
    });

    it("破坏性操作需要授权（不可逆，不擅自执行）", () => {
        expect(shouldEscalate(base({ destructive: "删除工作区外的构建缓存" }))?.reason).toBe("DESTRUCTIVE_ACTION");
    });

    it("需求歧义交给产品判断", () => {
        expect(shouldEscalate(base({ ambiguity: "匿名投票是否允许改票" }))?.reason).toBe("SPEC_AMBIGUITY");
    });

    it("同一失败连续 N 轮 → 判定打转（不是'再多试几次'能解决的）", () => {
        expect(shouldEscalate(base({ sameFailureStreak: SAME_FAILURE_LIMIT - 1 }))).toBeNull();
        const t = shouldEscalate(base({ sameFailureStreak: SAME_FAILURE_LIMIT, lastError: "exit=1 类型错误" }));
        expect(t?.reason).toBe("SAME_FAILURE_LOOP");
        expect(t?.tried.join(" ")).toContain("类型错误");   // 证据进了"我试过什么"
    });

    it("预算/墙钟耗尽且计划未完 → 由人决定要不要继续投入", () => {
        expect(shouldEscalate(base({ budgetExhausted: true, unfinishedUnits: 2 }))?.reason).toBe("BUDGET_EXHAUSTED");
        expect(shouldEscalate(base({ wallClockExhausted: true, unfinishedUnits: 1 }))?.reason).toBe("BUDGET_EXHAUSTED");
        // 边界：预算耗尽但计划已走完 → 不问了（没东西可决定）
        expect(shouldEscalate(base({ budgetExhausted: true, unfinishedUnits: 0 }))).toBeNull();
    });

    it("★ 有界：问满次数后不再打扰人（问人是能力，不是无限续命）", () => {
        const s = base({ envGaps: ["缺密钥"], escalationsUsed: MAX_ESCALATIONS_PER_TASK });
        expect(shouldEscalate(s)).toBeNull();
        expect(shouldEscalate(base({ envGaps: ["缺密钥"], escalationsUsed: MAX_ESCALATIONS_PER_TASK - 1 }))?.reason).toBe("NEEDS_ENV");
    });
});

describe("escalation / 组题：人拿到的是能决策的问题", () => {
    it("四段模板齐全 + 选项表原样 + 幂等 questionId", () => {
        const t = shouldEscalate(base({ envGaps: ["模型凭据未配置（401 或未配置）"] }))!;
        const q = buildEscalationQuestion(t, base({ envGaps: ["模型凭据未配置（401 或未配置）"] }));
        expect(q.prompt).toContain("【我在做什么】");
        expect(q.prompt).toContain("【我试过什么】");
        expect(q.prompt).toContain("【我判断的问题】");
        expect(q.prompt).toContain("【需要你决定什么】");
        expect(q.options).toEqual([...ESCALATION_OPTIONS]);
        expect(q.questionId).toBe(`esc-t1-NEEDS_ENV-1`);
        // 同一个第 1 次求助 → 同一个 questionId（HttpQuestioner 建题幂等，续跑不重复塞单子）
        expect(buildEscalationQuestion(t, base({ envGaps: ["x"] })).questionId).toBe(q.questionId);
    });

    it("选项 1 是安全默认（AUTO_CONFIRM / 无人应答时取它，必须最不坏）", () => {
        expect(ESCALATION_OPTIONS[0]).toContain("继续");
        expect(ESCALATION_OPTIONS[2]).toContain("停止");
    });
});

describe("escalation / 答案解析：确定性地翻成三个动作", () => {
    it("自动/默认应答（y / 空）→ continue（次数有界，不会无限续命）", () => {
        expect(parseEscalationAnswer("y").action).toBe("continue");
        expect(parseEscalationAnswer("").action).toBe("continue");
        expect(parseEscalationAnswer("  ").action).toBe("continue");
    });

    it("选项序号与关键词都能命中", () => {
        expect(parseEscalationAnswer("1").action).toBe("continue");
        expect(parseEscalationAnswer("2").action).toBe("narrow");
        expect(parseEscalationAnswer("3").action).toBe("stop");
        expect(parseEscalationAnswer("降级吧，先交后端").action).toBe("narrow");
        expect(parseEscalationAnswer("停止").action).toBe("stop");
        expect(parseEscalationAnswer("继续修").action).toBe("continue");
    });

    it("stop 优先于 other 关键词（宁停不乱试：'别继续做了' 不能读成继续）", () => {
        expect(parseEscalationAnswer("别继续做了，停").action).toBe("stop");
    });

    it("自由文本 → 当人的指示：continue + 原话进 guidance", () => {
        const d = parseEscalationAnswer("把 DB 换成 SQLite，别用 MySQL");
        expect(d.action).toBe("continue");
        expect(d.guidance).toBe("把 DB 换成 SQLite，别用 MySQL");
    });

    it("摘要可审计（原因 + 原话 + 动作）", () => {
        const s = base({ envGaps: ["缺密钥"] });
        const t = shouldEscalate(s)!;
        const q = buildEscalationQuestion(t, s);
        const line = describeEscalation(t, q, parseEscalationAnswer("3"));
        expect(line).toContain("NEEDS_ENV");
        expect(line).toContain("stop");
    });
});
