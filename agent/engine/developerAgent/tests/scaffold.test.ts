// tests/scaffold.test.ts —— 官方脚手架候选表（9/15，零 LLM 零网络）
//
//   验口径：确定性匹配（同输入必同输出）、未收录栈不出现（走手写兜底）、
//   候选命令一律非交互、提示词注入有/无候选两态。
import { describe, expect, it } from "bun:test";
import { matchScaffolds, scaffoldHintFor } from "../scaffold";

describe("scaffold / matchScaffolds 确定性匹配", () => {
    it("vue3 前端 → 有候选，且命令全是非交互形态（带 template 参数）", () => {
        const m = matchScaffolds({ frontend: "vue3", backend: "spring-boot" });
        const fe = m.find((x) => x.dimension === "frontend");
        expect(fe).toBeDefined();
        expect(fe!.stack).toBe("vue3");
        expect(fe!.candidates.length).toBeGreaterThanOrEqual(2);   // pnpm / npm 两种形态
        for (const c of fe!.candidates) {
            expect(c.command).toContain("{dir}");
            expect(c.command).toContain("--template");             // 非交互：模板显式指定
            expect(c.probe.length).toBeGreaterThan(0);             // 必须带探测命令
        }
    });

    it("backend 维度独立匹配（spring-boot → 后端候选），一次返回全部维度", () => {
        const m = matchScaffolds({ frontend: "vue3", backend: "spring-boot" });
        expect(m.map((x) => x.dimension).sort()).toEqual(["backend", "frontend"]);
        const be = m.find((x) => x.dimension === "backend");
        expect(be!.candidates.length).toBeGreaterThanOrEqual(1);
    });

    it("同输入必同输出（确定性：JSON 快照比对）", () => {
        const a = matchScaffolds({ frontend: "vue3", backend: "express" });
        const b = matchScaffolds({ frontend: "vue3", backend: "express" });
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it("未收录的栈 → 该维度不出现（不是报错；走手写兜底）", () => {
        const m = matchScaffolds({ frontend: "flutter-web", backend: "django" });
        expect(m).toEqual([]);
    });

    it("匹配是子串包含且大小写不敏感（vue-ts / Vue3 / NESTJS 都能命中）", () => {
        expect(matchScaffolds({ frontend: "Vue3", backend: "x" }).some((x) => x.dimension === "frontend")).toBe(true);
        expect(matchScaffolds({ frontend: "vue-ts", backend: "x" }).some((x) => x.dimension === "frontend")).toBe(true);
        expect(matchScaffolds({ frontend: "x", backend: "NestJS" }).some((x) => x.dimension === "backend")).toBe(true);
    });

    it("stackProfile 缺失 / 空串 → 空结果", () => {
        expect(matchScaffolds(null)).toEqual([]);
        expect(matchScaffolds({ frontend: "", backend: "" })).toEqual([]);
    });
});

describe("scaffold / scaffoldHintFor 提示词注入", () => {
    it("有候选 → 完整节：候选有序、探测先于执行、兜底规则齐备", () => {
        const hint = scaffoldHintFor({ frontend: "react", backend: "nest" });
        expect(hint).toContain("## 官方脚手架候选");
        expect(hint).toContain("**frontend：react**");
        expect(hint).toContain("**backend：nest**");
        expect(hint).toContain("探测命令");
        expect(hint).toContain("交互提示符");        // 卡交互 = 失败
        expect(hint).toContain("手写工程文件");      // 全失败 → 兜底
        expect(hint).toContain("runBuild");          // 产物仍要过最小可运行
        // 候选编号从 1 开始有序
        expect(hint).toContain("1. ");
    });

    it("未收录栈 → 空串（不产生空标题节，旧任务包零扰动）", () => {
        expect(scaffoldHintFor({ frontend: "django-cms", backend: "flask" })).toBe("");
        expect(scaffoldHintFor(null)).toBe("");
    });
});
