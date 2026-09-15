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
import { pickByPath, suggestServeCommand, fillVars, fillVarsDeep, deepEqual, evalAssertion, resolveResetTarget } from "../../contractProbeCore";
import type { JsonAssertion } from "../../contractProbeCore";
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

    it("多步契约（setup）原样透传：播数据 + 取变量都不能丢", () => {
        const proj = mk("vproj4", { "backend/package.json": JSON.stringify({ scripts: { dev: "node src/index.js" } }) });
        const setup = [
            { method: "POST", path: "/api/todos", body: { title: "A" }, expectedStatus: 201, extract: { name: "id", from: "data.id" } },
            { method: "PATCH", path: "/api/todos/{id}", body: { completed: true }, expectedStatus: 200 },
        ];
        const p = prepareCheck(proj, {
            id: "ac-9", kind: "CONTRACT", method: "GET", path: "/api/todos?status=completed", expectedStatus: 200, setup,
        } as never);
        const intent = JSON.parse(String(p.exec?.args[5]));
        expect(intent.setup).toEqual(setup);              // 一步不少、字段不变形
        expect(intent.path).toBe("/api/todos?status=completed");
    });

    it("结构化断言（assertJson）原样透传：过滤/汇总类判据的强度不能在路上丢", () => {
        const proj = mk("vproj5", { "backend/package.json": JSON.stringify({ scripts: { dev: "node src/index.js" } }) });
        const assertJson = [
            { path: "data", minLength: 1 },
            { path: "data", each: { path: "month", matches: "^2026-09" } },
            { path: "data.total", equals: 123.45 },
            { path: "data.0.secret", exists: false },
        ];
        const p = prepareCheck(proj, {
            id: "ac-10", kind: "CONTRACT", method: "GET", path: "/api/stats?month=2026-09", expectedStatus: 200, assertJson,
        } as never);
        const intent = JSON.parse(String(p.exec?.args[5]));
        expect(intent.assertJson).toEqual(assertJson);
    });

    it("assertJson 失败现场必须带原文（否则模型只能靠猜——p1 实弹：13 条全失败只看到「→ -」）", async () => {
        // 这条钉住的是**工具输出的可用性**：失败不带现场 = 逼模型自造验证（r5 的 25 次就是这么来的）。
        // 用真探针跑一个必然失败的靶子（不存在的服务），检查 output 里有可读原因。
        const proj = mk("vproj-fail", { "backend/package.json": JSON.stringify({ scripts: { dev: "node src/nope.js" } }) });
        const { runAcceptanceTool } = await import("../tools/runAcceptance");
        const ctx = {
            workspace: { exec: async () => ({ exitCode: 1, stdout: "", stderr: "", timedOut: false }) },
            projectDirAbs: proj,
            acceptanceChecks: [{ id: "ac-x", kind: "CONTRACT", method: "GET", path: "/api/x", expectedStatus: 200 }],
            owner: "developer", taskId: "t",
        } as never;
        const r = await runAcceptanceTool.run(ctx, { serveCommand: "node", serveArgs: ["src/nope.js"], bootWaitMs: 4_000, timeoutMs: 30_000 });
        expect(r.ok).toBe(false);
        // 现场必须在（不是只有一行 "→ -"）
        expect(r.output).toContain("ac-x");
        expect(r.output.length).toBeGreaterThan(80);
        expect(/服务启动失败|boot_failed|启动|现场|Cannot find/.test(r.output)).toBe(true);
    }, 60_000);

    it("resetPaths 双基准解析：serveCwd 相对与项目根相对都认（p1 实弹：描述与实现不一致导致 backend/backend/…）", () => {
        const proj = mk("vproj-reset", { "backend/data/ledger.db": "x", "backend/package.json": JSON.stringify({ scripts: { dev: "node x.js" } }) });
        const cwdAbs = path.join(proj, "backend");
        // ① serveCwd 相对（backend/data/ledger.db 真实存在）
        const a = resolveResetTarget(proj, cwdAbs, "data/ledger.db");
        expect(a.base).toBe("serveCwd");
        expect(a.abs).toBe(path.join(cwdAbs, "data", "ledger.db"));
        expect(a.ambiguous).toBe(false);
        // ② 项目根相对（同一文件，从项目根写）
        const b = resolveResetTarget(proj, cwdAbs, "backend/data/ledger.db");
        expect(b.abs).toBe(path.join(cwdAbs, "data", "ledger.db"));   // serveCwd 下不存在 backend/backend/... → 回退项目根
        expect(b.base).toBe("projectRoot");
        // ③ 绝对路径原样
        const abs = path.join(proj, "backend", "data", "ledger.db");
        expect(resolveResetTarget(proj, cwdAbs, abs)).toEqual({ abs, base: "absolute", ambiguous: false });
        // ④ 都不存在 → 给 serveCwd 候选（错误信息里是最可能的那个）
        const missing = resolveResetTarget(proj, cwdAbs, "data/nope.db");
        expect(missing.base).toBe("serveCwd");
        expect(missing.abs.endsWith("nope.db")).toBe(true);
    });

    it("自定义请求头（headers）原样透传——多身份判据（B 读 A 的私密项目→403）唯一的表达方式", () => {
        const proj = mk("vproj-hdr", { "backend/package.json": JSON.stringify({ scripts: { dev: "node src/index.js" } }) });
        const headers = { "X-User-Id": "2" };
        const setup = [
            { method: "POST", path: "/api/projects", body: { name: "私密项目" }, expectedStatus: 201,
              headers: { "X-User-Id": "1" }, extract: { name: "pid", from: "data.id" } },
        ];
        const p = prepareCheck(proj, {
            id: "ac-iso", kind: "CONTRACT", method: "GET", path: "/api/projects/{pid}", expectedStatus: 403,
            headers, setup,
        } as never);
        const intent = JSON.parse(String(p.exec?.args[5]));
        expect(intent.headers).toEqual(headers);              // 主请求的头（B 的身份）不能丢
        expect(intent.setup[0].headers).toEqual({ "X-User-Id": "1" });   // setup 的头（A 的身份）不能丢
        expect(intent.expectedStatus).toBe(403);
    });

    it("干净起点（resetPaths）透传进 serve 规格——「测试前清空数据库」从此是机械动作", () => {
        const proj = mk("vproj6", { "backend/package.json": JSON.stringify({ scripts: { dev: "node src/index.js" } }) });
        const p = prepareCheck(proj, {
            id: "ac-11", kind: "CONTRACT", method: "POST", path: "/api/todos", expectedStatus: 201,
            resetPaths: ["backend/data/todos.db"],
        } as never);
        const serve = JSON.parse(String(p.exec?.args[3]));
        expect(serve.resetPaths).toEqual(["backend/data/todos.db"]);   // 进的是 serve 规格（起服务前删）
    });
});

// ============================================================
describe("多步契约的变量机制（真实应用需要「先播数据再断言筛选」）", () => {
    it("pickByPath 按点路径取值，支持数组下标", () => {
        const obj = { data: { id: 7, items: [{ key: "k0" }, { key: "k1" }] } };
        expect(pickByPath(obj, "data.id")).toBe(7);
        expect(pickByPath(obj, "data.items.1.key")).toBe("k1");
        expect(pickByPath(obj, "id")).toBeUndefined();          // 没有就是 undefined，不猜
        expect(pickByPath(obj, "data.missing.deep")).toBeUndefined();
        expect(pickByPath(null, "a.b")).toBeUndefined();
    });

    it("fillVars 只替换已定义的占位符；未定义的**原样保留**（让它显式失败而不是悄悄发错请求）", () => {
        expect(fillVars("/api/todos/{id}", { id: "42" })).toBe("/api/todos/42");
        expect(fillVars("/api/todos/{nope}", {})).toBe("/api/todos/{nope}");
        expect(fillVars("/api/{a}/{b}", { a: "x", b: "y" })).toBe("/api/x/y");
    });

    it("fillVarsDeep 穿透对象与数组（body 里的占位符也能填）", () => {
        const out = fillVarsDeep({ title: "t-{id}", tags: ["{id}", "fixed"], nested: { ref: "{id}" } }, { id: "9" }) as Record<string, unknown>;
        expect(out["title"]).toBe("t-9");
        expect(out["tags"]).toEqual(["9", "fixed"]);
        expect((out["nested"] as Record<string, unknown>)["ref"]).toBe("9");
    });

    it("非字符串/非对象原样返回（数字布尔不被字符串化）", () => {
        expect(fillVarsDeep(7, { })).toBe(7);
        expect(fillVarsDeep(true, { })).toBe(true);
        expect(fillVarsDeep(null, { })).toBeNull();
    });
});

// ============================================================
// 结构化断言（assertJson）：过滤/隔离/汇总类语义的唯一可信判据
//
//   为什么必须单测这个：断言器**自己错了**比断言不过危险得多——它会静默把
//   坏实现判成绿的（正是本项目最反对的假绿）。所以每条形状的通过与不通过都要钉。
describe("evalAssertion / 结构化断言（治 expectBodyContains 的假绿）", () => {
    it("deepEqual 按内容比对象与数组（equals 的对象不能按引用比）", () => {
        expect(deepEqual({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 })).toBe(true);   // 键序无关
        expect(deepEqual([1, 2], [1, 2])).toBe(true);
        expect(deepEqual([1, 2], [2, 1])).toBe(false);
        expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
        expect(deepEqual(1, "1")).toBe(false);                                   // 不做隐式转换
        expect(deepEqual(null, undefined)).toBe(false);
    });

    it("exists: false 是**负向断言**——「不该出现的东西不出现」只能靠它验", () => {
        const root = { data: { id: 1 } };
        expect(evalAssertion(root, { path: "data.id", exists: true })).toBeNull();
        expect(evalAssertion(root, { path: "data.secret", exists: false })).toBeNull();
        // 反过来必须失败（否则负向断言形同虚设）
        expect(evalAssertion(root, { path: "data.secret", exists: true })).toContain("exists=true 不成立");
        expect(evalAssertion(root, { path: "data.id", exists: false })).toContain("exists=false 不成立");
    });

    it("equals 深等：金额汇总这类数值断言必须精确", () => {
        const root = { data: { total: 123.45, count: 3 } };
        expect(evalAssertion(root, { path: "data.total", equals: 123.45 })).toBeNull();
        expect(evalAssertion(root, { path: "data.total", equals: 123.46 })).toContain("期望深等于 123.46");
        expect(evalAssertion(root, { path: "data.count", equals: 3 })).toBeNull();
        expect(evalAssertion(root, { path: "data.count", equals: "3" })).not.toBeNull();  // 类型也算数
    });

    it("notEquals：筛选后**不应**再出现别的分类（负向）", () => {
        expect(evalAssertion({ categoryId: 2 }, { path: "categoryId", notEquals: 1 })).toBeNull();
        expect(evalAssertion({ categoryId: 1 }, { path: "categoryId", notEquals: 1 })).toContain("断言要求**不等于**");
    });

    it("contains：数组按元素深等、字符串按子串", () => {
        expect(evalAssertion({ tags: ["a", { k: 1 }] }, { path: "tags", contains: { k: 1 } })).toBeNull();
        expect(evalAssertion({ tags: ["a"] }, { path: "tags", contains: "b" })).toContain("数组不含期望元素");
        expect(evalAssertion({ msg: "created ok" }, { path: "msg", contains: "ok" })).toBeNull();
        expect(evalAssertion({ n: 5 }, { path: "n", contains: 5 })).toContain("不是数组也不是字符串");
    });

    it("length / minLength：区分「恰好 N 条」与「至少 N 条」", () => {
        const root = { data: [{ id: 1 }, { id: 2 }] };
        expect(evalAssertion(root, { path: "data", length: 2 })).toBeNull();
        expect(evalAssertion(root, { path: "data", length: 3 })).toContain("长度 2，期望恰好 3");
        expect(evalAssertion(root, { path: "data", minLength: 1 })).toBeNull();
        expect(evalAssertion({ data: [] }, { path: "data", minLength: 1 })).toContain("期望 ≥ 1");
        expect(evalAssertion({ n: 5 }, { path: "n", length: 1 })).toContain("不是数组/字符串");
    });

    it("each：过滤类判据的核心——数组**每一项**都满足才算过，空数组也过（故要配 minLength）", () => {
        const ok = { data: [{ status: "completed" }, { status: "completed" }] };
        expect(evalAssertion(ok, { path: "data", each: { path: "status", equals: "completed" } })).toBeNull();
        // 混进一条未完成的 → 必须失败，并指出是第几条（模型据此定位）
        const bad = { data: [{ status: "completed" }, { status: "active" }] };
        const why = evalAssertion(bad, { path: "data", each: { path: "status", equals: "completed" } });
        expect(why).toContain("data[1].status");
        // 空数组 each 恒过 —— 这正是它必须配 minLength 的原因（否则"过滤全空"也绿）
        expect(evalAssertion({ data: [] }, { path: "data", each: { path: "status", equals: "x" } })).toBeNull();
        expect(evalAssertion(ok, { path: "data", each: { path: "status", equals: "completed" }, minLength: 1 })).toBeNull();
    });

    it("形状非法 → 直接判失败并说明（不静默放过一条写错的断言）", () => {
        expect(evalAssertion({}, { path: "a" })).toContain("至少要有");
        expect(evalAssertion({}, { path: "a", equals: 1, exists: true })).toContain("同时给了");
    });

    it("matches：日期/前缀类过滤唯一能表达的形式（等值断言写不出来）", () => {
        const root = { data: [{ createdAt: "2026-09-15T05:10:01.612Z" }, { createdAt: "2026-09-02T00:00:00.000Z" }] };
        // 按月过滤：正确表达
        expect(evalAssertion(root, { path: "data", minLength: 1, each: { path: "createdAt", matches: "^2026-09" } })).toBeNull();
        // 混进一条 8 月的 → 必须红，并指出是第几条
        const bad = { data: [{ createdAt: "2026-09-15T00:00:00Z" }, { createdAt: "2026-08-31T00:00:00Z" }] };
        const why = evalAssertion(bad, { path: "data", each: { path: "createdAt", matches: "^2026-09" } });
        expect(why).toContain("data[1].createdAt");
        expect(why).toContain("不匹配正则");
        // 直接断言单个字符串
        expect(evalAssertion({ at: "2026-09-15" }, { path: "at", matches: "\\d{4}-\\d{2}-\\d{2}" })).toBeNull();
        // 非字符串 → 明确失败而不是静默通过
        expect(evalAssertion({ n: 9 }, { path: "n", matches: "9" })).toContain("不是字符串");
        // 正则写坏 → 明确失败（不吞异常）
        expect(evalAssertion({ s: "x" }, { path: "s", matches: "([" })).toContain("正则非法");
        // each 必须给 equals 或 matches
        expect(evalAssertion({ data: [1] }, { path: "data", each: { path: "x" } as never })).toContain("至少要给");
    });

    it("JSON 解析不出断言时**判失败**，绝不「解析不了就算过」", async () => {
        // 这条由探针主路径保证；这里钉住语义：非 JSON 响应体不可能通过结构化断言
        const why = evalAssertion(undefined, { path: "data", minLength: 1 });
        expect(why).not.toBeNull();
    });

    it("路径不存在时的报错是人可读的（模型能直接看懂缺什么）", () => {
        expect(evalAssertion({ data: {} }, { path: "data.items", each: { path: "x", equals: 1 } }))
            .toContain("不是数组（实际 undefined）");
    });
});
