// ============================================================
// architectTaskBuilder.test.ts —— ArchitectTask 自动装配的零 LLM 测试
//
//   全程不碰真实 LLM：语义输出由本地字面量/Fake 函数充当「LLM 的返回」。
//   覆盖：合法输出→建包、包能过 parseInbound、缺字段/权威字段/夹带解释文字被拒、
//        技术栈匹配 catalog（**匹配不上不阻止**）、验收意图机械生成、
//        指纹稳定、Hub 收到完整包、重复派发幂等、解析失败不进 Developer、
//        手写 fixture 仍可驱动 Developer、命令按工程文件解析（不按框架）。
//
//   9/15 两阶段派发（蓝图 + 按工作项逐批 architect_batch，第十节
//   dispatchArchitectTaskBatched）扩展了本模块，但**没动上面这些存量行为**——
//   本文件 1~19 号用例原样跑绿即回归证据；派发面的专项用例（顺序/重放/作废）
//   在 tests/architect-batch-dispatch.test.ts（脚本化 Fake ArchitectLlm）。
// ============================================================

import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TransferStation } from "../Hub";
import { parseInbound } from "../developerAgent/protocol";
import type { ArchitectTask } from "../developerAgent/protocol";
import { prepareCheck, runAcceptanceChecks, verdictKindOf } from "../developerAgent/live/verifier";
import { HubAdapter } from "../developerAgent/hubAdapter";
import { buildDeveloperGraph } from "../developerAgent/graph";
import type { DeveloperLlm, MessagePort } from "../developerAgent/graph";
import { DeveloperLedger } from "../developerAgent/ledger";
import { Workspace } from "../developerAgent/workspace";
import { initialDeveloperState } from "../developerAgent/state";
import type { DeveloperState } from "../developerAgent/state";
import { validateTestPassed } from "../developerAgent/protocol";
import {
    buildArchitectTaskFromPlan, collectArchitectSemantics, createArchitectTask,
    createMemoryDispatchRegistry, dispatchKeyOf, loadAssetCatalog, matchStackAssets,
    parseArchitectSemantics, resolveGenericCommand, retryPromptFor,
} from "../architectTaskBuilder";
import type { ArchitectSemantics } from "../architectTaskBuilder";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cf-arch-"));
afterAll(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 2 }); } catch { /* Windows 占用 */ }
});

// ---------- fixtures（充当「PM 结构化需求」与「LLM 语义输出」） ----------

const PM_PLAN = {
    project: "notes",
    features: [
        { name: "便签管理", description: "增删改查", priority: "高", acceptance: "接口全绿" },
        { name: "便签列表页", description: "展示列表", priority: "中" },
    ],
    phases: [{ phase: 1, name: "地基", goal: "最小可运行", features: ["便签管理"] }],
    mvp_scope: ["便签管理"],
    risks: ["无"],
};

const SEMANTICS: ArchitectSemantics = {
    goal: "做一个极简便签应用：列表 + 增删改查",
    features: [{ name: "便签管理", description: "新建/列表/查看/更新/删除" }],
    stack: { frontend: "Vue 3", backend: "Spring Boot 3.5", database: "MySQL 8", why: "团队熟悉且资产齐备" },
    entities: [{ entity: "Note", table: "note", fields: [{ name: "id", type: "Long" }, { name: "title", type: "String", required: true }] }],
    endpoints: [
        { method: "post", path: "/api/notes", purpose: "新建便签", expectedStatus: 201 },
        { method: "GET", path: "/api/notes", purpose: "列出便签" },
    ],
    pages: [{ path: "/notes", purpose: "便签列表页" }],
    workItems: [{ id: "w1-foundation", kind: "foundation", title: "前后端骨架" }],
    instructions: "先铺骨架，再写业务；不要改端口与契约路径。",
    risks: ["首次构建需要拉依赖"],
};

function newStation(): TransferStation {
    return new TransferStation({}, {});
}

/** 取出开发者收件箱里的 architect_task（没有则 null） */
function takeDeveloperTask(station: TransferStation): ArchitectTask | null {
    const msg = station.teams["developer"]?.inbox[0];
    if (!msg) return null;
    const parsed = parseInbound(msg.content);
    return parsed.ok ? (parsed.message as ArchitectTask) : null;
}

// ============================================================
describe("architect / LLM 输出解析（只吃纯 JSON）", () => {
    it("1. 合法语义输出 → 解析成功", () => {
        const r = parseArchitectSemantics(JSON.stringify(SEMANTICS));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.goal).toContain("便签");
    });

    it("夹带解释文字 / Markdown 说明 → 拒收（不是只吃 JSON 就不算过）", () => {
        expect(parseArchitectSemantics("好的，这是任务包：\n" + JSON.stringify(SEMANTICS)).ok).toBe(false);
        expect(parseArchitectSemantics("**方案**\n```json\n" + JSON.stringify(SEMANTICS) + "\n```").ok).toBe(false);
        // 纯 ```json 围栏（无额外文字）是可接受的
        expect(parseArchitectSemantics("```json\n" + JSON.stringify(SEMANTICS) + "\n```").ok).toBe(true);
    });

    it("2. 权威字段（done/verified/status/exitCode…）出现即拒收", () => {
        const bad = { ...SEMANTICS, verified: true };
        const r = parseArchitectSemantics(JSON.stringify(bad));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe("ARCHITECT_AUTHORITY_FIELD");
        expect(parseArchitectSemantics(JSON.stringify({ ...SEMANTICS, endpoints: [{ ...SEMANTICS.endpoints[0], exitCode: 0 }] })).ok).toBe(false);
    });

    it("3. 缺字段 / 空功能清单 / 空技术栈 → 拒收", () => {
        const noGoal: Record<string, unknown> = { ...SEMANTICS };
        delete noGoal["goal"];
        expect(parseArchitectSemantics(JSON.stringify(noGoal)).ok).toBe(false);
        expect(parseArchitectSemantics(JSON.stringify({ ...SEMANTICS, features: [] })).ok).toBe(false);
        expect(parseArchitectSemantics(JSON.stringify({ ...SEMANTICS, stack: undefined })).ok).toBe(false);
        expect(parseArchitectSemantics(JSON.stringify({ ...SEMANTICS, endpoints: [] })).ok).toBe(false);
        expect(parseArchitectSemantics(JSON.stringify({ ...SEMANTICS, pages: [] })).ok).toBe(false);
        // 未知关键字段：strictObject 直接拒（不许塞私货）
        expect(parseArchitectSemantics(JSON.stringify({ ...SEMANTICS, sneaky: 1 })).ok).toBe(false);
    });

    it("重试 Prompt 只带错误位置，不重发上下文", () => {
        const r = parseArchitectSemantics("not json at all");
        if (r.ok) throw new Error("应当失败");
        const p = retryPromptFor(r);
        expect(p).toContain("上一次输出不合格");
        expect(p).toContain("不是纯 JSON");
        expect(p.length).toBeLessThan(600);
    });

    it("有限重试：第一次坏、第二次好 → 成功且 attempts=2；一直坏 → ARCHITECT_FAILED", async () => {
        let n = 0;
        const ok = await collectArchitectSemantics({
            call: async () => (++n === 1 ? "垃圾输出" : JSON.stringify(SEMANTICS)),
            maxAttempts: 3,
        });
        expect(ok.ok).toBe(true);
        expect(ok.attempts).toBe(2);
        expect(ok.retryPrompts.length).toBe(1);

        const bad = await collectArchitectSemantics({ call: async () => "垃圾输出", maxAttempts: 2 });
        expect(bad.ok).toBe(false);
        expect(bad.attempts).toBe(2);
    });
});

// ============================================================
describe("architect / 技术栈匹配 catalog（匹配不上**不阻止**）", () => {
    it("catalog 资产全列；三槽位名字都能对上", () => {
        const catalog = loadAssetCatalog();
        // 9/8 起 catalog 加了两个 UI 库（element-plus / tdesign-vue-next），断言跟磁盘校准
        expect(catalog.map((a) => a.id).sort())
            .toEqual(["element-plus", "express", "mysql", "springboot", "tdesign-vue-next", "vue"]);
        const m = matchStackAssets({ frontend: "Vue 3 / Vite", backend: "Spring Boot 3.5.5", database: "MySQL 8", why: "x" }, catalog);
        expect(m.stackAssetMatched).toBe(true);
        expect(m.matched.map((x) => x.assetId)).toEqual(["vue", "springboot", "mysql"]);
    });

    it("4. 选了 catalog 里没有的技术栈 → 不报错、不阻止，只把 stackAssetMatched 置 false", () => {
        const built = buildArchitectTaskFromPlan({
            pmPlan: PM_PLAN, projectId: "notes",
            semantics: { ...SEMANTICS, stack: { frontend: "React 19", backend: "FastAPI", why: "团队更喜欢" } },
        });
        expect(built.ok).toBe(true);                         // ★ 不阻止任务
        expect(built.stackAssetMatched).toBe(false);
        // ★ 不偷偷替换成 Spring Boot
        expect(built.task!.stackProfile.frontend).toBe("React 19");
        expect(built.task!.stackProfile.backend).toBe("FastAPI");
        expect(built.notes.join("；")).toContain("不在 assets/catalog.json");
    });
});

// ============================================================
describe("architect / 任务包装配", () => {
    it("5. 合法语义 → 生成 ArchitectTask，且**能过 parseInbound**", () => {
        const built = buildArchitectTaskFromPlan({ pmPlan: PM_PLAN, projectId: "notes", semantics: SEMANTICS });
        expect(built.ok).toBe(true);
        const task = built.task!;
        expect(task.type).toBe("architect_task");
        expect(task.projectId).toBe("notes");
        expect(task.taskId).toBe("notes-p1");
        expect(task.allowedRoots).toEqual(["frontend", "backend"]);
        expect(task.forbiddenPaths.length).toBeGreaterThan(0);
        expect(task.stackProfile.frontend).toBe("Vue 3");
        const contract = task.contract as unknown as { pages: unknown[] };
        expect(contract.pages.length).toBe(1);
        expect(task.foundationPlan.workItems!.length).toBe(1);

        const round = parseInbound(JSON.stringify(task));
        expect(round.ok).toBe(true);                          // Developer 侧一定会收
    });

    it("6. 程序填充的机械字段一个都不来自 LLM", () => {
        const built = buildArchitectTaskFromPlan({ pmPlan: PM_PLAN, projectId: "notes", semantics: SEMANTICS });
        const task = built.task!;
        // ID / 权限 / 指纹 / 时间戳类字段由程序给
        expect(task.taskId).toMatch(/^notes-p\d+$/);
        expect(task.allowedRoots).toEqual(["frontend", "backend"]);
        expect(task.forbiddenPaths).toContain("backend/mvnw.cmd");
        expect(typeof built.packageHash).toBe("string");
        // LLM 的语义字段原样落地（不做二次发明）
        expect(task.requirementSnapshot.goal).toBe(SEMANTICS.goal);
        expect(task.developerInstructions).toBe(SEMANTICS.instructions);
    });

    it("7. acceptanceChecks 由 Contract/目录**机械生成**，命令一个都不预写", () => {
        const built = buildArchitectTaskFromPlan({ pmPlan: PM_PLAN, projectId: "notes", semantics: SEMANTICS });
        const checks = built.task!.acceptanceChecks as unknown as Record<string, unknown>[];
        expect(checks.map((c) => c["id"])).toEqual([
            "compile:frontend", "compile:backend",
            "http:POST:/api/notes", "http:GET:/api/notes",
        ]);
        for (const c of checks) {
            expect(c["command"]).toBeUndefined();             // ★ 不预写命令
        }
        const compile = checks.find((c) => c["id"] === "compile:backend")!;
        expect(compile["kind"]).toBe("COMPILE");
        expect(compile["target"]).toBe("backend");
        expect(compile["expected"]).toBe("exitCode=0");
        const post = checks.find((c) => c["id"] === "http:POST:/api/notes")!;
        expect(post["kind"]).toBe("CONTRACT");
        expect(post["expectedStatus"]).toBe(201);
    });

    it("8. 同一输入 → packageHash 稳定；内容变 → hash 变", () => {
        const a = buildArchitectTaskFromPlan({ pmPlan: PM_PLAN, projectId: "notes", semantics: SEMANTICS });
        const b = buildArchitectTaskFromPlan({ pmPlan: PM_PLAN, projectId: "notes", semantics: SEMANTICS });
        expect(a.packageHash).toBe(b.packageHash);
        const c = buildArchitectTaskFromPlan({
            pmPlan: PM_PLAN, projectId: "notes",
            semantics: { ...SEMANTICS, goal: "换个目标" },
        });
        expect(c.packageHash).not.toBe(a.packageHash);
    });
});

// ============================================================
describe("architect / Hub 派发（幂等，不新增服务）", () => {
    it("9. Hub 能收到完整 architect_task", async () => {
        const station = newStation();
        const out = await createArchitectTask({
            station, pmPlan: PM_PLAN, projectId: "notes",
            call: async () => JSON.stringify(SEMANTICS),
            ledgerPath: path.join(tmp, "disp-9.db"),   // 显式持久账本（默认实现就是它，路径换到 tmp 防测试互相污染）
        });
        expect(out.dispatched).toBe(true);
        expect(out.task).toBeDefined();

        const received = takeDeveloperTask(station);
        expect(received).not.toBeNull();
        expect(received!.taskId).toBe("notes-p1");
        expect(received!.acceptanceChecks.length).toBe(4);
        expect(received!.foundationPlan.workItems!.length).toBe(1);
    });

    it("10. 重复派发（同 taskId + packageHash）不产生第二条消息", async () => {
        const station = newStation();
        const registry = createMemoryDispatchRegistry();
        const opts = {
            station, pmPlan: PM_PLAN, projectId: "notes",
            call: async () => JSON.stringify(SEMANTICS),
            registry,
        };
        const first = await createArchitectTask(opts);
        const second = await createArchitectTask(opts);
        expect(first.dispatched).toBe(true);
        expect(second.dispatched).toBe(false);
        expect(second.issues.join("；")).toContain("重复派发");
        expect(station.teams["developer"]!.inbox.length).toBe(1);

        const key = dispatchKeyOf("notes-p1", first.packageHash!);
        expect(dispatchKeyOf("notes-p1", first.packageHash!)).toBe(key);
        expect(registry.isDuplicate(key)).toBe(true);
    });

    it("11. 解析失败 → 不派发（Developer 什么都收不到），并落 architect 失败事件", async () => {
        const station = newStation();
        const events: string[] = [];
        const out = await createArchitectTask({
            station, pmPlan: PM_PLAN, projectId: "notes",
            call: async () => "我建议用 React + NestJS（分析如下）……",
            ledgerPath: path.join(tmp, "disp-11.db"),
            onEvent: (e) => events.push(e.type),
        });
        expect(out.dispatched).toBe(false);
        expect(out.code).toBe("ARCHITECT_FAILED");
        expect(takeDeveloperTask(station)).toBeNull();
        expect(events).toContain("package_failed");
        expect(events).not.toContain("package_dispatched");
    });

    it("12. 正常路径落 package_created / package_validated / package_dispatched", async () => {
        const events: string[] = [];
        await createArchitectTask({
            station: newStation(), pmPlan: PM_PLAN, projectId: "notes",
            call: async () => JSON.stringify(SEMANTICS),
            ledgerPath: path.join(tmp, "disp-12.db"),
            onEvent: (e) => events.push(e.type),
        });
        expect(events).toEqual(["package_created", "package_validated", "package_dispatched"]);
    });
});

// ============================================================
describe("architect / 命令按**工程文件**解析（不按框架）", () => {
    const mk = (name: string, files: Record<string, string>): string => {
        const dir = path.join(tmp, name);
        fs.mkdirSync(dir, { recursive: true });
        for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
        return dir;
    };

    it("Maven Wrapper / Gradle Wrapper / package.json / python / go 都能识别", () => {
        expect(resolveGenericCommand(mk("mvn", { "mvnw.cmd": "x", "pom.xml": "<x/>" }), { isWin: true }))
            .toEqual({ command: "mvnw.cmd", args: ["-q", "package", "-DskipTests"], detectedBy: "maven-wrapper" });
        expect(resolveGenericCommand(mk("gradle", { "gradlew.bat": "x" }), { isWin: true }))
            .toEqual({ command: "gradlew.bat", args: ["build", "-x", "test"], detectedBy: "gradle-wrapper" });
        expect(resolveGenericCommand(mk("npm", { "package.json": JSON.stringify({ scripts: { build: "vite build" } }) })))
            .toEqual({ command: "npm", args: ["run", "build"], detectedBy: "package.json.scripts.build" });
        expect(resolveGenericCommand(mk("py", { "pyproject.toml": "[project]" }))!.detectedBy).toBe("python-project");
        expect(resolveGenericCommand(mk("go", { "go.mod": "module x" })))
            .toEqual({ command: "go", args: ["build", "./..."], detectedBy: "go-module" });
    });

    it("识别不出来 → 返回 null（**不猜**命令）", () => {
        expect(resolveGenericCommand(mk("empty", {}))).toBeNull();
        expect(resolveGenericCommand(mk("nobuild", { "package.json": JSON.stringify({ scripts: { dev: "vite" } }) }))).toBeNull();
        expect(resolveGenericCommand(path.join(tmp, "does-not-exist"))).toBeNull();
    });

    it("验收项两种形状分流：显式命令照跑，意图解析 / 跳过都说得清", () => {
        const proj = mk("proj", {});
        mk("proj/backend", { "mvnw.cmd": "x" });
        mk("proj/frontend", { "package.json": JSON.stringify({ scripts: { build: "vite build" } }) });

        const declared = prepareCheck(proj, { id: "d1", command: "node", args: ["-v"], cwd: "." } as never);
        expect(declared.exec?.resolvedBy).toBe("declared");

        const be = prepareCheck(proj, { id: "compile:backend", kind: "COMPILE", target: "backend" } as never);
        expect(be.exec).toEqual({ command: "mvnw.cmd", args: ["-q", "package", "-DskipTests"], cwd: "backend", resolvedBy: "maven-wrapper" });

        const fe = prepareCheck(proj, { id: "compile:frontend", kind: "COMPILE", target: "frontend" } as never);
        expect(fe.exec?.resolvedBy).toBe("package.json.scripts.build");

        const noEntry = prepareCheck(proj, { id: "compile:backend2", kind: "COMPILE", target: "nope" } as never);
        expect(noEntry.exec).toBeNull();
        expect(noEntry.skipReason).toContain("找不到通用工程入口");

        // ── CONTRACT（9/15 下沉改造后的新语义）──
        // 起服务方式**探得到** → 翻译成契约探针命令（可执行）；
        // 探不到 → 如实 skip（仍然不猜命令）。
        // 这条曾经断言"CONTRACT 必然 exec=null"——而那个行为就是 r5 的死因：
        // 8/10 判据无人执行 → verdictKindOf 永远 blocked_unverified → 永远拿不到 ready。
        mk("proj/backend", { "package.json": JSON.stringify({ scripts: { dev: "node src/index.js" } }) });
        const http = prepareCheck(proj, { id: "http:GET:/api/notes", kind: "CONTRACT", method: "GET", path: "/api/notes" } as never);
        expect(http.exec).not.toBeNull();                              // ← 现在真能跑了
        expect(http.exec?.command).toBe("bun");
        expect(http.exec?.args[0]).toBe("run");
        expect(http.exec?.args[1]).toContain("httpContractProbe.ts");
        expect(http.exec?.resolvedBy).toContain("contract-probe");
        expect(http.exec?.cwd).toBe("backend");                        // 检查在 serve.cwd 起
        // args = [run, <probe.ts>, --serve, <serveJson>, --intent, <intentJson>]
        expect(http.exec?.args[2]).toBe("--serve");
        expect(http.exec?.args[4]).toBe("--intent");
        const serveSpec = JSON.parse(String(http.exec?.args[3]));
        expect(serveSpec.why).toBe("package.json.scripts.dev");
        const intent = JSON.parse(String(http.exec?.args[5]));
        expect(intent).toEqual({ method: "GET", path: "/api/notes", expectedStatus: 200 });

        // 判据自己声明了 serveCommand → 优先用它（比工程文件探测更可信）
        const declaredServe = prepareCheck(proj, {
            id: "http:POST:/api/x", kind: "CONTRACT", method: "POST", path: "/api/x",
            expectedStatus: 201, serveCommand: "node", serveArgs: ["dist/server.js"], serveCwd: "backend",
        } as never);
        expect(declaredServe.exec?.resolvedBy).toContain("declared-serveCommand");
        expect(declaredServe.exec?.cwd).toBe("backend");

        // 没有任何起服务线索 → 如实跳过（**不猜命令**这条底线没变）
        const noServe = prepareCheck(mk("bare", {}), {
            id: "http:GET:/api/notes", kind: "CONTRACT", method: "GET", path: "/api/notes",
        } as never);
        expect(noServe.exec).toBeNull();
        expect(noServe.skipReason).toContain("找不到起服务的方式");

        // 缺 path 的畸形判据 → 跳过，说明原因
        const noPath = prepareCheck(proj, { id: "http:broken", kind: "CONTRACT", method: "GET" } as never);
        expect(noPath.exec).toBeNull();
        expect(noPath.skipReason).toContain("缺 path");
    });
});

// ============================================================
describe("architect / 手写 fixture 仍然可用（回归）", () => {
    const fixtures = [
        "live/mysite/T1-foundation.json",
        "live/mysite/T2-backend-projects.json",
        "live/mysite/T3a-diary.json",
        "live/smoke-e2e/S-e2e-crud.json",
    ];

    it("13. 仓库里的手写任务包都仍能通过 parseInbound，且验收项是显式命令", () => {
        const base = path.resolve(import.meta.dir, "..", "developerAgent");
        for (const rel of fixtures) {
            const raw = JSON.parse(fs.readFileSync(path.join(base, rel), "utf-8"));
            const parsed = parseInbound(raw);
            expect(parsed.ok).toBe(true);
            if (!parsed.ok) continue;
            const task = parsed.message as ArchitectTask;
            expect(task.type).toBe("architect_task");
            const checks = task.acceptanceChecks as unknown as Record<string, unknown>[];
            expect(checks.length).toBeGreaterThan(0);
            // 手写件走的是"显式命令"分支，历史行为不许被意图式改坏
            for (const c of checks) expect(typeof c["command"]).toBe("string");
        }
    });

    it("14. 手写任务的验收项在 TestAgent 侧仍按 declared 执行", () => {
        const base = path.resolve(import.meta.dir, "..", "developerAgent");
        const task = (parseInbound(
            JSON.parse(fs.readFileSync(path.join(base, "live/mysite/T2-backend-projects.json"), "utf-8")),
        ) as { ok: true; message: ArchitectTask }).message;
        const first = task.acceptanceChecks[0]!;
        const prepared = prepareCheck(tmp, first);
        expect(prepared.exec).not.toBeNull();
        expect(prepared.exec!.resolvedBy).toBe("declared");
    });
});

// ============================================================
describe("architect / Fake LLM 全链路：PM → Architect → Hub → Developer → TestAgent", () => {
    it("15. 自动任务包经 Hub 到达 Developer 并被真的执行；无机器证据不许凭空通过", async () => {
        const station = newStation();
        const projectDir = path.join(tmp, "e2e-project");
        fs.mkdirSync(path.join(projectDir, "backend"), { recursive: true });
        fs.mkdirSync(path.join(projectDir, "frontend"), { recursive: true });

        // ① Architect（Fake LLM）→ 装配 + 派发
        const out = await createArchitectTask({
            station, pmPlan: PM_PLAN, projectId: "notes",
            call: async () => JSON.stringify(SEMANTICS),
            ledgerPath: path.join(tmp, "disp-15.db"),
        });
        expect(out.dispatched).toBe(true);

        // ② Hub 那一跳：Developer 的 HubAdapter 真的能收到并解析
        const ledger = DeveloperLedger.open(path.join(tmp, "e2e.db"), "notes:notes-p1:test");
        const adapter = new HubAdapter({ station, ledger, trustedTestAgents: ["test-core"] });
        const received = await adapter.receive();
        expect(received.status).toBe("message");
        if (received.status !== "message") throw new Error("Developer 没收到 architect_task");
        const task = received.message as ArchitectTask;
        expect(received.sender).toBe("architect");
        expect(task.taskId).toBe("notes-p1");

        // ③ Developer（Fake LLM）拿着这个包跑图：写一个文件后 done
        let calls = 0;
        const decisions = [
            { kind: "tool", tool: "writeFile", args: { path: "backend/src/App.java", content: "class App {}" } },
            { kind: "done" },
        ];
        const llm: DeveloperLlm = {
            id: "fake", calls: () => calls,
            next: async () => {
                calls++;
                return decisions[Math.min(calls - 1, decisions.length - 1)];
            },
        };
        const tools = {
            describe: () => [], names: () => [],
            invoke: async (name: string, _c: unknown, args: Record<string, unknown>) => {
                if (name === "inspectTree") return { ok: true, output: "共 1 个文件", meta: { total: 1 } };
                if (name === "runBuild") return { ok: true, output: "exit=0", meta: { exitCode: 0 } };
                if (name === "writeFile" || name === "editFile") {
                    return { ok: true, output: "已写入", meta: { path: String(args["path"]), bytes: 3 } };
                }
                return { ok: true, output: "ok" };
            },
        } as never;
        const noPort: MessagePort = {
            send: () => "wake",
            receive: async () => ({ status: "invalid", error: "无消息", sender: null }),
        };
        const graph = buildDeveloperGraph({
            workspace: new Workspace({ projectDir, allowedRoots: task.allowedRoots }),
            tools, ledger, port: noPort, llm, trustedTestAgents: ["test-core"],
        });
        const final = await graph.invoke(initialDeveloperState({
            projectId: task.projectId, taskId: task.taskId, runId: "test", projectDir,
            allowedRoots: task.allowedRoots, messages: [task],
        })) as DeveloperState;

        expect(final.status).toBe("waiting_test");          // 开发完成，等外部验证
        expect(final.changedFiles).toContain("backend/src/App.java");
        expect(calls).toBe(2);

        // ④ TestAgent：项目里没有工程文件 → 意图式验收**全部跳过**，
        //    证据为空 ⇒ 不允许凭空 test_passed（空证据在 protocol 里就被拒）
        const verdict = await runAcceptanceChecks(projectDir, task.acceptanceChecks, "acc-test");
        expect(verdict.results.length).toBe(0);
        expect(verdict.firstFailure).toBeNull();
        expect(verdict.evidence.length).toBe(0);
        expect(verdict.skipped.map((s) => s.checkId)).toEqual([
            "compile:frontend", "compile:backend",
            "http:POST:/api/notes", "http:GET:/api/notes",
        ]);
        const rejected = validateTestPassed(
            {
                type: "test_passed", messageId: "m1", correlationId: "c1", projectId: task.projectId,
                taskId: task.taskId, runId: "test", verifiedBy: "test-core", acceptanceHash: "acc-test",
                evidence: verdict.evidence,
            } as never,
            "test-core",
            {
                trustedSenders: ["test-core"], projectId: task.projectId, taskId: task.taskId,
                runId: "test", correlationId: "c1", acceptanceHash: "acc-test",
            },
        );
        expect(rejected.ok).toBe(false);                    // ★ 没有机器证据就不许通过
        ledger.close();
    }, 30_000);
});

// ============================================================
// 反向用例：把这些口子钉死——skipped 不许冒充通过、重复派发必须被持久账本拦住、
// Architect 漏掉 PM 功能不许派发、kind 错配不算匹配。
// ============================================================
describe("architect / 反向用例（不许通过的口子）", () => {
    it("16. 编译成功但 HTTP skipped → 结论是 blocked_unverified，且真的落成 blocked（不发 test_passed）", async () => {
        const NODE = Bun.which("node") ?? process.execPath;
        const proj = path.join(tmp, "verdict-proj");
        fs.mkdirSync(proj, { recursive: true });

        // 一条显式命令的编译检查（真跑、通过）+ 一条意图式 CONTRACT（没人执行 → skipped）
        const verdict = await runAcceptanceChecks(proj, [
            { id: "compile:ok", command: NODE, args: ["-e", "process.exit(0)"], cwd: "." } as never,
            { id: "http:POST:/api/notes", kind: "CONTRACT", method: "POST", path: "/api/notes" } as never,
        ], "acc-16");
        expect(verdict.results.length).toBe(1);
        expect(verdict.results[0]!.exitCode).toBe(0);
        expect(verdict.firstFailure).toBeNull();
        expect(verdict.skipped.map((s) => s.checkId)).toEqual(["http:POST:/api/notes"]);
        expect(verdictKindOf(verdict)).toBe("blocked_unverified");   // ★ 不是 test_passed

        // 落地：Developer 端真的变成 blocked，error 带 BLOCKED_UNVERIFIED，终态幂等
        const { createDeveloperAgent } = await import("../developerAgent/index");
        const handle = createDeveloperAgent({
            projectId: "notes", taskId: "notes-p1",
            projectDir: proj, allowedRoots: ["backend"],
            ledgerPath: path.join(tmp, "verdict-16.db"),
            llm: { id: "fake", calls: () => 0, next: async () => ({ kind: "done" }) },
        });
        const st = await handle.blockUnverified({
            reason: "本轮验收有 1 项未执行（http:POST:/api/notes），不许 test_passed",
            skipped: verdict.skipped,
        });
        expect(st.status).toBe("blocked");
        expect(st.error).toContain("[BLOCKED_UNVERIFIED]");
        expect(handle.ledger.loadState()?.status).toBe("blocked");
        // 终态幂等：再调一次不覆盖（也不再重复清进程/发消息）
        const again = await handle.blockUnverified({ reason: "第二次", skipped: [] });
        expect(again.status).toBe("blocked");
        expect(again.error).toContain("[BLOCKED_UNVERIFIED]");
        handle.close();
    }, 30_000);

    it("17. 两次独立 createArchitectTask 调用（持久化 Ledger）→ 第二次不派发", async () => {
        const station = newStation();
        const opts = {
            station, pmPlan: PM_PLAN, projectId: "notes",
            call: async () => JSON.stringify(SEMANTICS),
            // ★ 不传 registry：走默认持久化 Ledger（同一个账本文件跨调用共享）
            ledgerPath: path.join(tmp, "disp-17.db"),
        };
        const first = await createArchitectTask(opts);
        const second = await createArchitectTask(opts);
        expect(first.dispatched).toBe(true);
        expect(second.dispatched).toBe(false);
        expect(second.issues.join("；")).toContain("重复派发");
        expect(station.teams["developer"]!.inbox.length).toBe(1);   // 收件箱里只有第一条
    });

    it("18. Architect 漏掉 PM 功能 → 拒绝派发（ARCHITECT_FEATURE_MISMATCH）", async () => {
        // PM 本阶段要求两条功能，语义只给了一条
        const pmPlan = {
            ...PM_PLAN,
            phases: [{ phase: 1, name: "地基", goal: "最小可运行", features: ["便签管理", "便签列表页"] }],
        };
        const built = buildArchitectTaskFromPlan({ pmPlan, projectId: "notes", semantics: SEMANTICS });
        expect(built.ok).toBe(false);
        expect(built.code).toBe("ARCHITECT_FEATURE_MISMATCH");
        expect(built.issues.join("；")).toContain("便签列表页");

        // 端到端：Developer 什么都收不到，事件里没有 package_dispatched
        const station = newStation();
        const events: string[] = [];
        const out = await createArchitectTask({
            station, pmPlan, projectId: "notes",
            call: async () => JSON.stringify(SEMANTICS),
            ledgerPath: path.join(tmp, "disp-18.db"),
            onEvent: (e) => events.push(e.type),
        });
        expect(out.dispatched).toBe(false);
        expect(out.code).toBe("ARCHITECT_FEATURE_MISMATCH");
        expect(takeDeveloperTask(station)).toBeNull();
        expect(events).toContain("package_rejected");
        expect(events).not.toContain("package_dispatched");
    });

    it("19. backend 资产填进 frontend 槽位 → 命中了 id 但 kindOk=false → stackAssetMatched=false", () => {
        const catalog = loadAssetCatalog();
        const m = matchStackAssets({ frontend: "Spring Boot 3.5", backend: "Vue 3", why: "写反了" }, catalog);
        // id 确实都命中了（所以旧判据 assetId!==null 会误判成 matched）
        expect(m.matched.every((x) => x.assetId !== null)).toBe(true);
        expect(m.matched.find((x) => x.slot === "frontend")!.kindOk).toBe(false);
        expect(m.matched.find((x) => x.slot === "backend")!.kindOk).toBe(false);
        expect(m.stackAssetMatched).toBe(false);                    // ★ 新判据：id 命中且 kind 相符才算匹配

        // 不阻止任务：包照常生成，stackProfile 不被偷换
        const built = buildArchitectTaskFromPlan({
            pmPlan: PM_PLAN, projectId: "notes",
            semantics: { ...SEMANTICS, stack: { frontend: "Spring Boot 3.5", backend: "Vue 3", why: "写反了" } },
        });
        expect(built.ok).toBe(true);
        expect(built.stackAssetMatched).toBe(false);
        expect(built.task!.stackProfile.frontend).toBe("Spring Boot 3.5");
    });
});
