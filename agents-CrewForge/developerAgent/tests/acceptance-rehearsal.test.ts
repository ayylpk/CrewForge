// tests/acceptance-rehearsal.test.ts —— 批 E 两件套（零 LLM、零外网）
//
//   ① runAcceptance 工具：把任务包的可机械执行判据（COMPILE 命令 + CONTRACT 契约）
//      一次性批量真跑。**这里只测"分流是否正确"**（哪些能跑、哪些如实跳过、
//      起服务命令怎么选）——真起服务打 HTTP 由实弹跑验证，单测不 mock 一个假服务器
//      来假装测过了（那正是本项目最反对的"假绿"）。
//
//   ② budgetText：预算文案三档。r5 的 145 调全程没有一次 test_request，
//      根因就是模型看不见预算——这条文案是那个缺口的补丁，必须有测试钉住。
import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { budgetText } from "../realLlm";
import { suggestServeCommand } from "../../contractProbeCore";
import { prepareCheck } from "../live/verifier";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cforge-accept-"));
const mk = (rel: string, files: Record<string, string>): string => {
    const dir = path.join(tmp, rel);
    fs.mkdirSync(dir, { recursive: true });
    for (const [f, c] of Object.entries(files)) {
        const abs = path.join(dir, f);
        fs.mkdirSync(path.dirname(abs), { recursive: true });   // 支持 "backend/package.json" 这类嵌套键
        fs.writeFileSync(abs, c);
    }
    return dir;
};

// ============================================================
describe("budgetText / 预算可见性（r5 的「不知道要见底」缺口）", () => {
    it("无预算信息 → 空串（旧调用方零感知，不产生空节）", () => {
        expect(budgetText(undefined)).toBe("");
        expect(budgetText({ used: 0, total: 0 })).toBe("");
        expect(budgetText({ used: 0, total: Number.NaN })).toBe("");
    });

    it("充足（剩余 > 30%）→ 报数 + 强调完成批次就验，不催命", () => {
        const s = budgetText({ used: 10, total: 100 });
        expect(s).toContain("已用 10 / 100");
        expect(s).toContain("剩余 90");
        expect(s).toContain("预算充足");
        expect(s).not.toContain("告急");
        expect(s).not.toContain("偏紧");
    });

    it("偏紧（≤30%）→ 提醒优先完成当前工作项、不要大范围重构", () => {
        const s = budgetText({ used: 75, total: 100 });
        expect(s).toContain("预算偏紧");
        expect(s).toContain("不要开启大范围重构");
        expect(s).not.toContain("告急");
    });

    it("告急（≤10%）→ 明确要求停止探索、立即预演、尽快收敛", () => {
        const s = budgetText({ used: 92, total: 100 });
        expect(s).toContain("告急");
        expect(s).toContain("不要再开启新的探索");
        expect(s).toContain("runAcceptance");
        expect(s).toContain("立即");
    });

    it("剩余 ≤5 步也判告急（比例还有 10% 但绝对量已不够干活）", () => {
        const s = budgetText({ used: 95, total: 100 });
        expect(s).toContain("告急");
        expect(budgetText({ used: 46, total: 50 })).toContain("告急");   // 剩 4 步
    });

    it("用满 → 剩余 0 仍给告急文案（不出现负数 / 崩溃）", () => {
        const s = budgetText({ used: 100, total: 100 });
        expect(s).toContain("剩余 0");
        expect(s).toContain("告急");
        const over = budgetText({ used: 150, total: 100 });
        expect(over).toContain("剩余 0");                                // 钳到 0，不吐负数
    });
});

// ============================================================
describe("suggestServeCommand / 起服务探测（不猜框架，只读工程文件）", () => {
    it("有 dev 脚本 → 优先 dev（热重载，最贴近真实起法）", () => {
        const dir = mk("hasdev", { "package.json": JSON.stringify({ scripts: { dev: "tsx watch src/index.ts", build: "tsc" } }) });
        const r = suggestServeCommand(dir, { isWin: true });
        expect(r?.why).toBe("package.json.scripts.dev");
        expect(r?.args).toEqual(["run", "dev"]);
        expect(r?.command).toBe("npm.cmd");                              // Windows 上 .cmd 后缀必须有
    });

    it("没有 dev 但有 start → 用 start", () => {
        const dir = mk("hasstart", { "package.json": JSON.stringify({ scripts: { start: "node dist/index.js" } }) });
        expect(suggestServeCommand(dir)?.why).toBe("package.json.scripts.start");
    });

    it("只有 main 且是 node 可直跑的 .js → 用 main 入口", () => {
        const dir = mk("mainjs", { "package.json": JSON.stringify({ main: "./src/app.js" }), "src/app.js": "// x" });
        const r = suggestServeCommand(dir);
        expect(r?.why).toBe("package.json.main=./src/app.js");
        expect(r?.args).toEqual(["src/app.js"]);
    });

    it("main 指向 .ts → **不兜底**（node 起不来，猜了就是白烧一轮）", () => {
        const dir = mk("maints", { "package.json": JSON.stringify({ main: "./src/app.ts" }), "src/app.ts": "// x" });
        expect(suggestServeCommand(dir)).toBeNull();
    });

    it("退到常见入口文件（顺序固定，命中即用）", () => {
        expect(suggestServeCommand(mk("entry1", { "src/index.js": "// x" }))?.why).toBe("entry-file:src/index.js");
        expect(suggestServeCommand(mk("entry2", { "server.js": "// x" }))?.why).toBe("entry-file:server.js");
    });

    it("什么都没有 → null（**不猜**：调用方据此如实 skip 判据）", () => {
        expect(suggestServeCommand(mk("empty2", {}))).toBeNull();
        expect(suggestServeCommand(path.join(tmp, "does-not-exist"))).toBeNull();
    });

    it("探测错误只可能造成「诚实失败」，**不可能**造成「没跑却说通过」（红线论证）", () => {
        // 探针的通过条件是"真发一次 HTTP 请求拿到期望状态码"：
        // 起服务命令猜错 → 服务起不来 → 探针报"服务启动失败 + 启动日志"。
        // 这条测试钉住的是**设计意图**：探测失败路径必须返回 null（跳过），
        // 而不是返回一个"看起来能跑"的假命令。
        const dir = mk("weird", { "package.json": "{ 这不是合法 JSON" });
        expect(suggestServeCommand(dir)).toBeNull();
    });
});

// ============================================================
describe("verifier / CONTRACT 判据的翻译（验收通道打通）", () => {
    it("能起服务 → CONTRACT 变成可执行的契约探针命令（不再是 skipped）", () => {
        const proj = mk("vproj", { "backend/package.json": JSON.stringify({ scripts: { dev: "node src/index.js" } }) });
        const p = prepareCheck(proj, {
            id: "ac-3", kind: "CONTRACT", method: "GET", path: "/api/todos", expectedStatus: 200,
        } as never);
        expect(p.exec).not.toBeNull();
        expect(p.exec?.command).toBe("bun");
        // args = [run, <probe.ts>, --serve, <json>, --intent, <json>]
        expect(p.exec?.args[1]).toContain("httpContractProbe.ts");
        const serve = JSON.parse(String(p.exec?.args[3]));
        expect(serve.cwd).toBe(".");                                     // 探针自身 cwd=serve.cwd，内部不再嵌套
        const intent = JSON.parse(String(p.exec?.args[5]));
        expect(intent.method).toBe("GET");
        expect(intent.path).toBe("/api/todos");
        expect(intent.expectedStatus).toBe(200);
    });

    it("带 body / 关键字断言 / 登录前置的判据，参数**原样**传进探针（不丢信息）", () => {
        const proj = mk("vproj2", { "backend/package.json": JSON.stringify({ scripts: { dev: "node src/index.js" } }) });
        const p = prepareCheck(proj, {
            id: "ac-4", kind: "CONTRACT", method: "POST", path: "/api/login",
            expectedStatus: 200, body: { user: "a", pass: "b" },
            expectBodyContains: "token", auth: { method: "POST", path: "/api/login", body: { user: "a" } },
        } as never);
        const intent = JSON.parse(String(p.exec?.args[5]));
        expect(intent.body).toEqual({ user: "a", pass: "b" });
        expect(intent.expectBodyContains).toBe("token");
        expect(intent.auth).toEqual({ method: "POST", path: "/api/login", body: { user: "a" } });
    });

    it("serveCwd 默认 backend，可被判据覆盖（前端契约不适用但语义要通）", () => {
        const proj = mk("vproj3", {
            "backend/package.json": JSON.stringify({ scripts: { dev: "node src/index.js" } }),
            "frontend/package.json": JSON.stringify({ scripts: { dev: "vite" } }),
        });
        const def = prepareCheck(proj, { id: "c1", kind: "CONTRACT", method: "GET", path: "/x" } as never);
        expect(def.exec?.cwd).toBe("backend");
        const over = prepareCheck(proj, { id: "c2", kind: "CONTRACT", method: "GET", path: "/x", serveCwd: "frontend" } as never);
        expect(over.exec?.cwd).toBe("frontend");
    });
});
