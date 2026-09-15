// tests/history-prune.test.ts —— 历史总量护栏 + 参数字段裁剪（9/15 批 B，零 LLM 零网络）
//
//   验口径（对应"防越窗"与"防过度压缩"两条红线）：
//     · 预算内**一个字节都不动**（不折腾没超的上下文）；
//     · 超预算只折**最老**且**折到够用就停**（最小干预，不把工作集一起抽走）；
//     · 最近 HISTORY_PROTECT_CHARS 内**永不折叠**；
//     · 折叠**幂等**（重复扫描不二次切割）且**明示**（含"已执行过、别重做"防幻觉文案）；
//     · 指令语义条目（error / reminder）不参与折叠——它们小，且折了等于拆刹车片。
import { describe, expect, it } from "bun:test";
import {
    clipArgsForModel, pruneHistory,
    HISTORY_BUDGET_CHARS, HISTORY_PROTECT_CHARS, HISTORY_FOLDED_NOTE,
    MODEL_ARG_FIELD_LIMIT,
} from "../graph";

/** 造一条工具结果历史条目（output 撑到指定字符数） */
const toolEntry = (tool: string, chars: number, args: Record<string, unknown> = { path: "a.ts" }) => ({
    tool, args, ok: true, output: "x".repeat(chars), rejected: null,
});

describe("pruneHistory / 不越窗（该折才折）", () => {
    it("总量在预算内 → 一个条目都不折，history 原样", () => {
        const h = [toolEntry("readFile", 1000), toolEntry("search", 1000)];
        const before = JSON.stringify(h);
        const r = pruneHistory(h);
        expect(r.folded).toBe(0);
        expect(r.charsBefore).toBe(r.charsAfter);
        expect(JSON.stringify(h)).toBe(before);       // 内容零改动
    });

    it("超预算 → 从最老开始折；最新的条目**原样保留**（保护窗红线）", () => {
        // 每条 ~10K 字符，塞 20 条 ≈ 200K，远超 96K 预算
        const h: unknown[] = [];
        for (let i = 0; i < 20; i++) h.push(toolEntry("readFile", 10_000, { path: `f${i}.ts` }));
        const r = pruneHistory(h);

        expect(r.folded).toBeGreaterThan(0);
        expect(r.charsAfter).toBeLessThanOrEqual(HISTORY_BUDGET_CHARS);
        // 最新一条必须没被折（模型手头的工作集）
        const last = h[h.length - 1] as Record<string, unknown>;
        expect(last["folded"]).toBeUndefined();
        expect(last["output"]).not.toBe(HISTORY_FOLDED_NOTE);
        // 最老一条被折了
        expect((h[0] as Record<string, unknown>)["folded"]).toBe(true);
    });

    it("折到够用就停手（最小干预，不把老条目全折光）", () => {
        const h: unknown[] = [];
        for (let i = 0; i < 30; i++) h.push(toolEntry("readFile", 10_000, { path: `f${i}.ts` }));
        pruneHistory(h);
        const foldedCount = h.filter((e) => (e as Record<string, unknown>)["folded"] === true).length;
        // 30 条 × 10K = 300K，要降到 96K 需折约 21 条；绝不能把 30 条全折了
        expect(foldedCount).toBeGreaterThan(0);
        expect(foldedCount).toBeLessThan(30);
        expect(h.filter((e) => (e as Record<string, unknown>)["folded"] === true).length)
            .toBeLessThan(25);
    });

    it("保护窗内的条目即便总量超预算也不折（HISTORY_PROTECT_CHARS 内是工作集）", () => {
        // 前面塞一条巨量老条目把总量顶爆；尾部若干小条目落在保护窗内
        const tailCount = 4;
        const perTail = 5_000;
        expect(tailCount * perTail).toBeLessThan(HISTORY_PROTECT_CHARS);   // 前提成立才谈得上"保护"
        const h: unknown[] = [toolEntry("readFile", 200_000, { path: "old.ts" })];
        for (let i = 0; i < tailCount; i++) h.push(toolEntry("readFile", perTail, { path: `recent${i}.ts` }));

        pruneHistory(h);
        expect((h[0] as Record<string, unknown>)["folded"]).toBe(true);    // 老的那条被折
        for (let i = 1; i <= tailCount; i++) {                             // 保护窗内的全部原样
            expect((h[i] as Record<string, unknown>)["folded"]).toBeUndefined();
        }
    });
});

describe("pruneHistory / 折叠的形状（防幻觉与幂等）", () => {
    it("折叠条目保留 tool + 参数摘要 + ok，并带**明示**文案", () => {
        const h: unknown[] = [toolEntry("runCommand", 200_000, { command: "npm test" })];
        pruneHistory(h);
        const e = h[0] as Record<string, unknown>;
        expect(e["tool"]).toBe("runCommand");                       // 仍知道"做过什么"
        expect(e["args"]).toEqual({ command: "npm test" });          // 短参数原样保留
        expect(e["ok"]).toBe(true);                                 // 仍知道"成没成"
        expect(e["output"]).toBe(HISTORY_FOLDED_NOTE);
        // 防幻觉：必须明确告诉模型"调用已执行过、别重做"
        expect(String(e["output"])).toContain("已经按原样执行过");
        expect(String(e["output"])).toContain("不要因此重做");
    });

    it("大块参数只压正文，**定位信息原样留住**（path 丢了模型会去猜/重做）", () => {
        const h: unknown[] = [{
            tool: "writeFile",
            args: { path: "big.vue", content: "y".repeat(50_000) },
            ok: true, output: "z".repeat(200_000), rejected: null,
        }];
        pruneHistory(h);
        const args = (h[0] as Record<string, unknown>)["args"] as Record<string, unknown>;
        expect(args["path"]).toBe("big.vue");                        // 定位信息必须原样
        const content = String(args["content"]);
        expect(content).toContain("已省略");                          // 大正文被压
        expect(content.length).toBeLessThan(500);
        expect(JSON.stringify(args).length).toBeLessThan(1000);
    });

    it("幂等：连折两次，第二次不再动已折条目（不二次切割、不重复计数）", () => {
        const h: unknown[] = [];
        for (let i = 0; i < 20; i++) h.push(toolEntry("readFile", 10_000, { path: `f${i}.ts` }));
        const first = pruneHistory(h);
        const afterFirst = JSON.stringify(h);
        const second = pruneHistory(h);
        expect(first.folded).toBeGreaterThan(0);
        expect(second.folded).toBe(0);                    // 已折的不重复折
        expect(JSON.stringify(h)).toBe(afterFirst);       // 内容零变化
    });

    it("指令语义条目（error / reminder）不参与折叠——折了等于拆刹车片", () => {
        const h: unknown[] = [
            { error: "LLM 请求失败：超时。下一步照常给出决策。" },
            { reminder: "[重复调用提醒] 你已连续 3 次…" },
            ...Array.from({ length: 20 }, (_, i) => toolEntry("readFile", 10_000, { path: `f${i}.ts` })),
        ];
        pruneHistory(h);
        expect((h[0] as Record<string, unknown>)["error"]).toBeTruthy();
        expect((h[1] as Record<string, unknown>)["reminder"]).toBeTruthy();
        expect((h[0] as Record<string, unknown>)["folded"]).toBeUndefined();
    });
});

describe("clipArgsForModel / 参数字段护栏", () => {
    it("短参数原样（路径/命令/行号这类不动）", () => {
        const args = { path: "src/a.ts", offset: 1, limit: 100, command: "npm test" };
        expect(clipArgsForModel(args)).toEqual(args);
    });

    it(`超 ${MODEL_ARG_FIELD_LIMIT} 字符的字符串字段折中段，并声明"已按完整参数执行"`, () => {
        const big = "c".repeat(20_000);
        const out = clipArgsForModel({ path: "big.vue", content: big });
        const content = out["content"] as string;
        expect(out["path"]).toBe("big.vue");
        expect(content.length).toBeLessThan(big.length);
        expect(content).toContain("中段省略");
        // 防幻觉：必须说清"只是记录省略，调用按完整参数执行过"
        expect(content).toContain("完整");
        expect(content).toContain("以磁盘为准");
    });

    it("非字符串参数（数字/布尔/对象）原样透传", () => {
        const nested = { a: 1 };
        const out = clipArgsForModel({ n: 5, flag: true, obj: nested });
        expect(out["n"]).toBe(5);
        expect(out["flag"]).toBe(true);
        expect(out["obj"]).toBe(nested);
    });
});
