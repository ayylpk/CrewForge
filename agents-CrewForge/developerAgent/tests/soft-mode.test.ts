// tests/soft-mode.test.ts —— 本机 soft 模式的启用与"必须自报隔离程度"（零 LLM）
//
//   本阶段定稿：**启用本机 soft 执行，不实现 Docker**。
//   所以这一组测试要把两件事钉死：
//     · 显式 soft + backend=local 时，命令真的能在本机跑起来；
//     · 每一条执行结果都自报 realIsolation=false / softIsolation=true / backend=local，
//       默认 strict 时**不会**执行任何本机命令。
//
//   ⚠️ soft 不是沙箱：子进程有宿主机用户权限、能读项目外文件、网络无法强制隔离、
//      Windows 进程树终止是 best-effort。下面这些断言只证明"受约束"，不证明"已隔离"。
import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../workspace";
import { DeveloperLedger } from "../ledger";
import { createFullDeveloperToolRegistry, DEVELOPER_ROLE_NAME } from "../tools/registry";
import type { ToolContext } from "../tools/registry";
import { resolveSandboxCapabilities } from "../tools/processSandbox";
import { createDeveloperAgent } from "../index";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-dev-soft-"));
const NODE = Bun.which("node") ?? process.execPath;
const registry = createFullDeveloperToolRegistry();
const opened: DeveloperLedger[] = [];
let seq = 0;

afterAll(() => {
    for (const l of opened) { try { l.close(); } catch { /* 已关 */ } }
});

function newProject(name: string): string {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, "backend"), { recursive: true });
    fs.mkdirSync(path.join(dir, "frontend"), { recursive: true });
    return dir;
}

/** 本机 soft：mode=soft + backend=local（本阶段唯一允许的真实执行模式） */
function softWs(projectDir: string, o: { maxOutputBytes?: number } = {}): { ws: Workspace; ledger: DeveloperLedger } {
    const ledger = DeveloperLedger.open(path.join(root, `soft-${seq++}.db`), "p1:t1");
    opened.push(ledger);
    const ws = new Workspace({
        projectDir,
        allowedRoots: ["backend", "frontend"],
        sandbox: {
            mode: "soft",
            backend: "local",
            maxOutputBytes: o.maxOutputBytes ?? 256 * 1024,
            watchIntervalMs: 500,
        },
        ledgerIntegrity: () => ledger.integrityCounters(),
    }, (rec) => ledger.appendEvent("write_audit", rec), {
        onProcessEvent: (ev) => ledger.recordProcessEvent({
            kind: ev.kind,
            taskId: String(ev.payload["taskId"] ?? "T1"),
            processId: typeof ev.payload["processId"] === "string" ? ev.payload["processId"] : null,
            pid: typeof ev.payload["pid"] === "number" ? ev.payload["pid"] : null,
            command: typeof ev.payload["command"] === "string" ? ev.payload["command"] : "",
            args: Array.isArray(ev.payload["args"]) ? ev.payload["args"] as string[] : [],
            detail: ev.payload,
        }),
        onViolation: (v) => ledger.recordViolation({
            code: v.code, target: v.target, message: v.message, taskId: "T1",
        }),
    });
    return { ws, ledger };
}

const ctxOf = (ws: Workspace): ToolContext => ({
    workspace: ws, owner: "developerAgent", role: DEVELOPER_ROLE_NAME, taskId: "T1",
});

/** 每条执行结果的共同断言：必须自报隔离程度，且**不许**声称已隔离 */
function expectSoftFlags(meta: Record<string, unknown> | undefined): void {
    expect(meta?.["realIsolation"]).toBe(false);
    expect(meta?.["softIsolation"]).toBe(true);
    expect(meta?.["sandboxMode"]).toBe("soft");
    expect(meta?.["sandboxBackend"]).toBe("local");
}

function freePort(): number {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
    const p = probe.port;
    probe.stop(true);
    if (!p) throw new Error("无法取得空闲端口");
    return p;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ============================================================
describe("soft / 能力探测（soft + local 才是本阶段允许的执行模式）", () => {
    it("mode=soft + backend=local → realIsolation=false / softIsolation=true / backend=local", () => {
        const caps = resolveSandboxCapabilities({ mode: "soft", backend: "local" });
        expect(caps.mode).toBe("soft");
        expect(caps.backend).toBe("local");
        expect(caps.realIsolation).toBe(false);
        expect(caps.softIsolation).toBe(true);
    });

    it("只写 mode=soft 也默认 backend=local（报告里不许含糊成 none）", () => {
        expect(resolveSandboxCapabilities({ mode: "soft" }).backend).toBe("local");
    });

    it("限制条款必须写清 5 条本机风险", () => {
        const caps = resolveSandboxCapabilities({ mode: "soft", backend: "local" });
        const text = caps.limitations.join("；");
        expect(text).toContain("宿主机用户权限");
        expect(text).toContain("读取项目外的文件");
        expect(text).toContain("不能绝对阻止");
        expect(text).toContain("网络访问无法");
        expect(text).toContain("taskkill");
        expect(text).toContain("不得用于生产");
    });
});

// ============================================================
describe("soft / 命令真的能在本机跑（且自报隔离程度）", () => {
    it("1. node --version 可执行", async () => {
        const dir = newProject("version");
        const { ws } = softWs(dir);
        const r = await registry.invoke("runCommand", ctxOf(ws), { command: NODE, args: ["--version"] });
        expect(r.ok).toBe(true);
        expect(String(r.output)).toMatch(/v\d+\./);
        expectSoftFlags(r.meta);
    }, 30_000);

    it("2. node -e 可执行", async () => {
        const dir = newProject("node-e");
        const { ws } = softWs(dir);
        const r = await registry.invoke("runCommand", ctxOf(ws), { command: NODE, args: ["-e", "console.log('soft-ok')"] });
        expect(r.ok).toBe(true);
        expect(r.output).toContain("soft-ok");
        expectSoftFlags(r.meta);
    }, 30_000);

    it("3+4. 本地 HTTP 服务可启动，httpRequest 可打 localhost", async () => {
        const dir = newProject("http");
        const { ws } = softWs(dir);
        const port = freePort();
        ws.writeAtomic("backend/srv.cjs",
            "const http=require('node:http');\n" +
            `http.createServer((q,s)=>{s.writeHead(200,{'content-type':'application/json'});s.end(JSON.stringify({ok:true,url:q.url}));}).listen(${port},'127.0.0.1',()=>console.log('up'));\n`,
            { owner: "developerAgent", taskId: "T1" });

        const started = await registry.invoke("startProcess", ctxOf(ws), {
            command: NODE, args: ["srv.cjs"], cwd: "backend", waitMs: 1500,
        });
        expect(started.ok).toBe(true);
        expectSoftFlags(started.meta);
        const processId = String(started.meta?.["processId"]);

        const http = await registry.invoke("httpRequest", ctxOf(ws), {
            url: `http://127.0.0.1:${port}/ping`, timeoutMs: 8000,
        });
        expect(http.ok).toBe(true);
        expect(http.meta?.["status"]).toBe(200);

        const stopped = await registry.invoke("stopProcess", ctxOf(ws), { processId });
        expect(stopped.ok).toBe(true);
        expectSoftFlags(stopped.meta);
    }, 60_000);

    it("5. 超时可以终止进程树（心跳停止）", async () => {
        const dir = newProject("timeout");
        const { ws } = softWs(dir);
        ws.writeAtomic("backend/child.cjs",
            "const fs=require('node:fs');const p=require('node:path');\n" +
            "setInterval(()=>fs.appendFileSync(p.join(__dirname,'hb.txt'),'x'),120);\n",
            { owner: "developerAgent", taskId: "T1" });
        ws.writeAtomic("backend/parent.cjs",
            "const {spawn}=require('node:child_process');const p=require('node:path');\n" +
            "spawn(process.execPath,[p.join(__dirname,'child.cjs')],{stdio:'ignore'});\n" +
            "setInterval(()=>{},1000);\n",
            { owner: "developerAgent", taskId: "T1" });

        const r = await registry.invoke("runCommand", ctxOf(ws), {
            command: NODE, args: ["parent.cjs"], cwd: "backend", timeoutMs: 2500,
        });
        expect(r.meta?.["timedOut"]).toBe(true);
        expectSoftFlags(r.meta);
        expect(["taskkill", "process-group", "pid"]).toContain(String(r.meta?.["killMethod"]));

        const hb = path.join(dir, "backend", "hb.txt");
        expect(fs.existsSync(hb)).toBe(true);
        await sleep(400);
        const size = fs.statSync(hb).size;
        await sleep(900);
        expect(fs.statSync(hb).size).toBe(size);
    }, 60_000);

    it("6. 敏感环境变量不会进入子进程", async () => {
        const dir = newProject("env");
        const { ws } = softWs(dir);
        process.env["DEEPSEEK_API_KEY"] = "sk-soft-must-not-leak";
        process.env["MYSQL_PASSWORD"] = "pw-soft-must-not-leak";
        process.env["REDIS_PASSWORD"] = "pw-redis";
        try {
            const r = await registry.invoke("runCommand", ctxOf(ws), {
                command: NODE,
                args: ["-e", "console.log(JSON.stringify({a:process.env.DEEPSEEK_API_KEY??null,b:process.env.MYSQL_PASSWORD??null,c:process.env.REDIS_PASSWORD??null}))"],
            });
            expect(r.output).toContain('"a":null');
            expect(r.output).toContain('"b":null');
            expect(r.output).toContain('"c":null');
            expect(String(r.output)).not.toContain("must-not-leak");
            // 只记名字，不记值
            const removed = r.meta?.["envRemoved"] as string[];
            expect(removed).toContain("DEEPSEEK_API_KEY");
            expect(removed).toContain("MYSQL_PASSWORD");
            expect(JSON.stringify(r.meta)).not.toContain("must-not-leak");
        } finally {
            delete process.env["DEEPSEEK_API_KEY"];
            delete process.env["MYSQL_PASSWORD"];
            delete process.env["REDIS_PASSWORD"];
        }
    }, 30_000);

    it("7. 任务结束可以清理进程（cancelTask / shutdown 两条路径）", async () => {
        const dir = newProject("cleanup");
        const agent = createDeveloperAgent({
            projectId: "p1", taskId: "T1", projectDir: dir,
            allowedRoots: ["backend", "frontend"],
            ledgerPath: path.join(root, `cleanup-${seq++}.db`),
            llm: { id: "never", calls: () => 0, next: async () => ({ kind: "done" }) },
            sandbox: { mode: "soft", backend: "local" },
        });
        opened.push(agent.ledger);
        agent.workspace.startProcess(NODE, ["-e", "setInterval(()=>{},1000)"], {}, { owner: "developerAgent", taskId: "T1" });
        expect(agent.inspectTaskState().activeProcesses).toBe(1);
        await agent.cancelTask("soft 模式清理测试");
        expect(agent.inspectTaskState().activeProcesses).toBe(0);
        await agent.shutdown();
    }, 30_000);

    it("8. 输出截断 + 原始日志可用（日志里能找到被截掉的部分）", async () => {
        const dir = newProject("truncate");
        const { ws } = softWs(dir, { maxOutputBytes: 300 });
        const r = await registry.invoke("runCommand", ctxOf(ws), {
            command: NODE, args: ["-e", "for(let i=0;i<1500;i++)console.log('soft-line-'+i)"],
        });
        expect(r.meta?.["truncated"]).toBe(true);
        const raw = String(r.meta?.["rawOutputPath"]);
        expect(fs.existsSync(raw)).toBe(true);
        expect(fs.readFileSync(raw, "utf-8")).toContain("soft-line-1499");
        expectSoftFlags(r.meta);
    }, 30_000);
});

// ============================================================
describe("soft / 默认 strict 绝不宿主裸跑", () => {
    it("9. 不传 sandbox（strict + none）→ SANDBOX_UNAVAILABLE，且本机命令没被执行", async () => {
        const dir = newProject("strict-default");
        const ws = new Workspace({ projectDir: dir, allowedRoots: ["backend", "frontend"] });
        const marker = path.join(dir, "must-not-exist.txt");
        const r = await registry.invoke("runCommand", ctxOf(ws), {
            command: NODE, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`],
        });
        expect(r.ok).toBe(false);
        expect(r.rejected?.code).toBe("SANDBOX_UNAVAILABLE");
        expect(fs.existsSync(marker)).toBe(false);
        expect(ws.sandboxCapabilities.realIsolation).toBe(false);
        expect(ws.sandboxCapabilities.softIsolation).toBe(false);
    }, 20_000);

    it("10. agent 默认配置下 strict 会让任务直接 blocked（不进 LLM）", async () => {
        const dir = newProject("strict-agent");
        let llmCalls = 0;
        const agent = createDeveloperAgent({
            projectId: "p1", taskId: "T1", projectDir: dir,
            allowedRoots: ["backend", "frontend"],
            ledgerPath: path.join(root, `strict-${seq++}.db`),
            llm: { id: "spy", calls: () => llmCalls, next: async () => { llmCalls++; return { kind: "done" }; } },
            // 刻意不传 sandbox
        });
        opened.push(agent.ledger);
        const caps = agent.sandboxCapabilities();
        expect(caps.realIsolation).toBe(false);
        expect(caps.softIsolation).toBe(false);

        const state = await agent.run({
            task: {
                type: "architect_task", projectId: "p1", taskId: "T1",
                requirementSnapshot: { goal: "strict 阻断验证" },
                stackProfile: { frontend: "vue3", backend: "spring-boot" },
                domainModel: { entity: "note" }, contract: { version: "1", endpoints: [] },
                foundationPlan: { dirs: ["backend"] },
                allowedRoots: ["backend"], forbiddenPaths: [],
                acceptanceChecks: [], developerInstructions: "",
            },
        });
        expect(state.status).toBe("blocked");
        expect(String(state.error)).toContain("SANDBOX_UNAVAILABLE");
        expect(llmCalls).toBe(0);                    // ★ 一次模型调用都不该发生
        expect(agent.ledger.listEvents().some((e) => e.type === "sandbox_unavailable")).toBe(true);
        await agent.shutdown();
    }, 30_000);

    it("soft 启动会在 Ledger 里留一条 sandbox_soft_mode（不是隔离，别被读成隔离）", async () => {
        const dir = newProject("soft-lint");
        const ledgerPath = path.join(root, `softlint-${seq++}.db`);
        const agent = createDeveloperAgent({
            projectId: "p1", taskId: "T1", projectDir: dir,
            allowedRoots: ["backend", "frontend"], ledgerPath,
            llm: { id: "never", calls: () => 0, next: async () => ({ kind: "done" }) },
            sandbox: { mode: "soft", backend: "local" },
        });
        opened.push(agent.ledger);
        // 直接触发一次 run：本机 soft 允许进图，Ledger 应记录 soft 模式与限制
        await agent.run({
            task: {
                type: "architect_task", projectId: "p1", taskId: "T1",
                requirementSnapshot: { goal: "soft 留痕验证" },
                stackProfile: { frontend: "vue3", backend: "spring-boot" },
                domainModel: { entity: "note" }, contract: { version: "1", endpoints: [] },
                foundationPlan: { dirs: ["backend"] },
                allowedRoots: ["backend"], forbiddenPaths: [],
                acceptanceChecks: [], developerInstructions: "",
            },
        });
        const ev = agent.ledger.listEvents().find((e) => e.type === "sandbox_soft_mode");
        expect(ev).toBeDefined();
        expect(JSON.stringify(ev?.payload)).toContain("不得用于生产");
        await agent.shutdown();
    }, 60_000);
});
