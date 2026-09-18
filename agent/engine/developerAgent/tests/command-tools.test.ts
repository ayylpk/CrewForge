// tests/command-tools.test.ts —— Claude Code 式命令能力（零 LLM）
//
//   覆盖规格第九节里"命令与进程能力"那几条：
//     1 Developer 可以执行 node --version
//     2 Developer 可以执行 node -e
//     3 Developer 可以执行自定义项目脚本
//     4 Developer 可以启动本地 HTTP 服务
//     5 httpRequest 可以访问 localhost
//     6 readProcess 可以读取新增输出
//     7 stopProcess 可以清理父子进程
//     8 命令超时会杀掉整个进程树
//     9 输出过长会被截断并标记 truncated
//    15 进程在任务完成和崩溃恢复后都会清理
//
//   全部走显式 `sandbox: { mode: "soft" }`；真实模式（strict）下这些一律不可用。
import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Workspace } from "../workspace";
import { DeveloperLedger } from "../ledger";
import { createFullDeveloperToolRegistry, DEVELOPER_ROLE_NAME } from "../tools/registry";
import type { ToolContext } from "../tools/registry";
import { resolveShell } from "../tools/shell";
import { parseTarget } from "../tools/httpRequest";
import { createDeveloperAgent } from "../index";
import { cleanupTempDirsAfterTests, tmpDir } from "./_tmp";

const root = tmpDir("cf-dev-cmd");
/**
 * 用**真的 node**（不是测试运行器自己的可执行文件）。
 * 之前用 process.execPath，在 `bun test` 里它指向 bun.exe——那样"node --version"
 * 测的其实是 bun，名字和事实不符；而且 bun 嵌套 spawn bun 在本机直接 EPERM。
 */
const NODE = Bun.which("node") ?? process.execPath;
const registry = createFullDeveloperToolRegistry();
const opened: DeveloperLedger[] = [];
let seq = 0;

// 清理分两步，**顺序不能反**：先关账本（这些用例建真 sqlite，开着库删树在 Windows 上必 EBUSY），
// 再交给 _tmp.ts 删树（重试 + 退避 + 大超时）。老写法只关账本、把目录丢给系统清理，
// 就是 %TEMP% 里越攒越多的那个漏点。bun 的钩子按注册顺序执行，所以清理钩子必须写在下面之后。
afterAll(() => {
    for (const l of opened) { try { l.close(); } catch { /* 已关 */ } }
});
cleanupTempDirsAfterTests();

function newProject(name: string): string {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, "backend"), { recursive: true });
    fs.mkdirSync(path.join(dir, "frontend"), { recursive: true });
    return dir;
}

function softWs(projectDir: string, o: { maxOutputBytes?: number; ledger?: DeveloperLedger; taskId?: string } = {}): { ws: Workspace; ledger: DeveloperLedger } {
    const ledger = o.ledger ?? DeveloperLedger.open(path.join(root, `cmd-${seq++}.db`), "p1:t1");
    if (!opened.includes(ledger)) opened.push(ledger);
    const ws = new Workspace({
        projectDir,
        allowedRoots: ["backend", "frontend"],
        sandbox: {
            mode: "soft",
            maxOutputBytes: o.maxOutputBytes ?? 256 * 1024,
            watchIntervalMs: 500,
        },
        ledgerIntegrity: () => ledger.integrityCounters(),
    }, (rec) => ledger.appendEvent("write_audit", rec), {
        onProcessEvent: (ev) => ledger.recordProcessEvent({
            kind: ev.kind,
            taskId: String(ev.payload["taskId"] ?? o.taskId ?? "T1"),
            processId: typeof ev.payload["processId"] === "string" ? ev.payload["processId"] : null,
            pid: typeof ev.payload["pid"] === "number" ? ev.payload["pid"] : null,
            command: typeof ev.payload["command"] === "string" ? ev.payload["command"] : "",
            args: Array.isArray(ev.payload["args"]) ? ev.payload["args"] as string[] : [],
            detail: ev.payload,
        }),
        onViolation: (v) => ledger.recordViolation({
            code: v.code, target: v.target, message: v.message, taskId: o.taskId ?? "T1",
        }),
    });
    return { ws, ledger };
}

const ctxOf = (ws: Workspace): ToolContext => ({
    workspace: ws, owner: "developerAgent", role: DEVELOPER_ROLE_NAME, taskId: "T1",
});

/** 要一个当前空闲的端口（先占再放，拿到号就用） */
function freePort(): number {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
    const p = probe.port;
    probe.stop(true);
    if (!p) throw new Error("无法取得空闲端口");
    return p;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ============================================================
describe("command / 任意命令都能跑", () => {
    it("node --version（runCommand，command 与 args 分开传）", async () => {
        const dir = newProject("node-version");
        const { ws } = softWs(dir);
        const r = await registry.invoke("runCommand", ctxOf(ws), { command: NODE, args: ["--version"] });
        expect(r.ok).toBe(true);
        expect(r.meta?.["exitCode"]).toBe(0);
        expect(String(r.output)).toMatch(/v\d+\./);
    }, 30_000);

    it("node -e 内联脚本", async () => {
        const dir = newProject("node-e");
        const { ws } = softWs(dir);
        const r = await registry.invoke("runCommand", ctxOf(ws), {
            command: NODE, args: ["-e", "console.log(6*7)"],
        });
        expect(r.ok).toBe(true);
        expect(r.output).toContain("42");
    }, 30_000);

    it("自定义项目脚本（真的读得到刚写进项目的文件）", async () => {
        const dir = newProject("custom-script");
        const { ws } = softWs(dir);
        ws.writeAtomic("backend/tools/report.mjs",
            "import fs from 'node:fs';\nconsole.log('report-script-ok', fs.existsSync('tools/input.txt'));\n",
            { owner: "developerAgent", taskId: "T1" });
        ws.writeAtomic("backend/tools/input.txt", "hello", { owner: "developerAgent", taskId: "T1" });

        const r = await registry.invoke("runCommand", ctxOf(ws), {
            command: NODE, args: ["tools/report.mjs"], cwd: "backend",
        });
        expect(r.ok).toBe(true);
        expect(r.output).toContain("report-script-ok true");
    }, 30_000);

    it("shell：完整命令字符串（管道 / 串联）", async () => {
        const dir = newProject("shell-pipe");
        const { ws } = softWs(dir);
        const isWin = process.platform === "win32";
        const cmd = isWin
            ? "echo hello-from-shell | findstr hello-from-shell"
            : "echo hello-from-shell | grep hello-from-shell";
        const r = await registry.invoke("shell", ctxOf(ws), { command: cmd });
        expect(r.ok).toBe(true);
        expect(r.output).toContain("hello-from-shell");
        expect(r.meta?.["shell"]).toBe(isWin ? "cmd" : "sh");

        // 串联：第二条命令只在第一条成功时才跑
        const chain = isWin
            ? `echo first && echo second`
            : `echo first && echo second`;
        const r2 = await registry.invoke("shell", ctxOf(ws), { command: chain });
        expect(r2.ok).toBe(true);
        expect(r2.output).toContain("first");
        expect(r2.output).toContain("second");
    }, 30_000);

    it("resolveShell 选对 shell，parseTarget 只认 http/https", () => {
        expect(resolveShell("echo hi", "cmd")).toEqual({ command: "cmd", args: ["/c", "echo hi"], shell: "cmd" });
        expect(resolveShell("echo hi", "sh").args).toEqual(["-lc", "echo hi"]);
        expect(resolveShell("echo hi", "powershell").args.slice(0, 2)).toEqual(["-NoLogo", "-NonInteractive"]);
        expect(parseTarget("http://127.0.0.1:8080/x").ok).toBe(true);
        expect(parseTarget("file:///etc/passwd").ok).toBe(false);
        expect(parseTarget("not a url").ok).toBe(false);
    });

    it("runBuild：识别不到工程入口 → NO_BUILD_ENTRY，不执行任何猜测命令（9/13 去 Maven 硬编码）", async () => {
        const dir = newProject("runbuild-no-entry");
        const { ws } = softWs(dir);
        const r = await registry.invoke("runBuild", ctxOf(ws), { target: "frontend" });
        expect(r.ok).toBe(false);
        expect(r.meta?.["code"]).toBe("NO_BUILD_ENTRY");
        expect(r.meta?.["command"]).toBeNull();
        expect(r.meta?.["exitCode"]).toBeNull();
        expect(String(r.output)).toContain("NO_BUILD_ENTRY");
    }, 30_000);

    it("runBuild：backend 有 mvnw.cmd 走 Maven Wrapper（真执行：cmd 桩 exit 0，不碰 npm）", async () => {
        const dir = newProject("runbuild-maven-stub");
        fs.writeFileSync(path.join(dir, "backend", "mvnw.cmd"), "@echo off\r\nexit /b 0\r\n");
        const { ws } = softWs(dir);
        const r = await registry.invoke("runBuild", ctxOf(ws), { target: "backend" });
        expect(r.ok).toBe(true);
        expect(r.meta?.["command"]).toBe("mvnw.cmd");
        expect(r.meta?.["detectedBy"]).toBe("maven-wrapper");
        expect(String(r.output)).toContain("[build:backend]");
    }, 60_000);
});

// ============================================================
describe("command / 本地服务与 HTTP 调试", () => {
    it("startProcess 起服务 → httpRequest 打 localhost → readProcess 读增量 → stopProcess 收工", async () => {
        const dir = newProject("http-service");
        const { ws, ledger } = softWs(dir);
        const port = freePort();
        const server = [
            "const http = require('node:http');",
            "let n = 0;",
            `http.createServer((req, res) => { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({path: req.url, ok: true})); }).listen(${port}, '127.0.0.1', () => console.log('listening'));`,
            "setInterval(() => console.log('tick-' + (++n)), 120);",
        ].join("\n");
        ws.writeAtomic("backend/server.cjs", server, { owner: "developerAgent", taskId: "T1" });

        const started = await registry.invoke("startProcess", ctxOf(ws), {
            command: NODE, args: ["server.cjs"], cwd: "backend", label: "test-server", waitMs: 1500,
        });
        expect(started.ok).toBe(true);
        const processId = String(started.meta?.["processId"]);
        expect(processId).toBeTruthy();

        const http = await registry.invoke("httpRequest", ctxOf(ws), {
            url: `http://127.0.0.1:${port}/api/ping`, method: "GET", timeoutMs: 8000,
        });
        expect(http.ok).toBe(true);
        expect(http.meta?.["status"]).toBe(200);
        expect(String(http.output)).toContain('"ok":true');

        // 增量读取：第一次读到 log，等一会再读应当拿到**新增**的 tick
        const first = await registry.invoke("readProcess", ctxOf(ws), { processId });
        expect(first.ok).toBe(true);
        await sleep(600);
        const second = await registry.invoke("readProcess", ctxOf(ws), { processId });
        expect(second.ok).toBe(true);
        expect(String(second.meta?.["newStdoutChars"])).not.toBe("0");
        expect(String(second.output)).toContain("tick-");

        const stopped = await registry.invoke("stopProcess", ctxOf(ws), { processId });
        expect(stopped.ok).toBe(true);
        expect(stopped.meta?.["status"]).toBe("killed");

        // 进程生命周期三类动作都必须入账（规格五.9）
        const kinds = ledger.listProcessEvents().map((e) => e.kind);
        expect(kinds).toContain("process_started");
        expect(kinds).toContain("process_polled");
        expect(kinds).toContain("process_stopped");

        // 停掉之后端口应当真的释放
        await sleep(300);
        const probe = Bun.serve({ port, fetch: () => new Response("back") });
        probe.stop(true);
    }, 60_000);

    it("httpRequest 默认拒外网（网络策略只放行本机回环）", async () => {
        const dir = newProject("http-external");
        const { ws } = softWs(dir);
        const r = await registry.invoke("httpRequest", ctxOf(ws), { url: "https://example.com/" });
        expect(r.ok).toBe(false);
        expect(r.rejected?.code).toBe("NETWORK_DENIED");
    }, 20_000);
});

// ============================================================
describe("command / 终止与清理", () => {
    it("命令超时会杀掉整棵进程树（子进程不再写心跳）", async () => {
        const dir = newProject("timeout-tree");
        const { ws } = softWs(dir);
        // 父进程拉一个每 120ms 追加心跳的子进程，然后自己挂着不退
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
        expect(r.meta?.["exitCode"]).toBeNull();

        const hb = path.join(dir, "backend", "hb.txt");
        // 超时前心跳应当已经在写
        expect(fs.existsSync(hb)).toBe(true);
        await sleep(400);
        const sizeAfterKill = fs.statSync(hb).size;
        await sleep(900);
        // 父与子都被收掉 → 心跳停止增长
        expect(fs.statSync(hb).size).toBe(sizeAfterKill);
    }, 60_000);

    it("stopProcess：父子进程一起清掉", async () => {
        const dir = newProject("stop-tree");
        const { ws } = softWs(dir);
        ws.writeAtomic("backend/child.cjs",
            "const fs=require('node:fs');const p=require('node:path');\n" +
            "setInterval(()=>fs.appendFileSync(p.join(__dirname,'hb2.txt'),'x'),120);\n",
            { owner: "developerAgent", taskId: "T1" });
        ws.writeAtomic("backend/parent.cjs",
            "const {spawn}=require('node:child_process');const p=require('node:path');\n" +
            "spawn(process.execPath,[p.join(__dirname,'child.cjs')],{stdio:'ignore'});\n" +
            "setInterval(()=>{},1000);\n",
            { owner: "developerAgent", taskId: "T1" });

        const started = await registry.invoke("startProcess", ctxOf(ws), {
            command: NODE, args: ["parent.cjs"], cwd: "backend", waitMs: 1200,
        });
        const processId = String(started.meta?.["processId"]);
        const pid = Number(started.meta?.["pid"]);
        expect(started.ok).toBe(true);

        const hb = path.join(dir, "backend", "hb2.txt");
        await sleep(500);
        expect(fs.existsSync(hb)).toBe(true);

        const stopped = await registry.invoke("stopProcess", ctxOf(ws), { processId });
        expect(stopped.ok).toBe(true);
        expect(["taskkill", "process-group", "pid"]).toContain(String(stopped.meta?.["killMethod"]));

        await sleep(400);
        const size = fs.statSync(hb).size;
        await sleep(900);
        expect(fs.statSync(hb).size).toBe(size);
        // 父进程本身也确实死了
        expect(isAlive(pid)).toBe(false);
    }, 60_000);

    it("cleanupTaskProcesses 把该任务剩下的进程全清掉", async () => {
        const dir = newProject("cleanup-task");
        const { ws } = softWs(dir);
        const p1 = ws.startProcess(NODE, ["-e", "setInterval(()=>{},1000)"], {}, { owner: "developerAgent", taskId: "T1" });
        const p2 = ws.startProcess(NODE, ["-e", "setInterval(()=>{},1000)"], {}, { owner: "developerAgent", taskId: "T1" });
        expect(ws.sandbox.activeCount("T1")).toBe(2);
        const killed = await ws.cleanupTaskProcesses("T1");
        expect(killed).toBe(2);
        expect(ws.sandbox.activeCount("T1")).toBe(0);
        expect(isAlive(p1.pid)).toBe(false);
        expect(isAlive(p2.pid)).toBe(false);
    }, 30_000);

    it("cancelTask 会清理遗留进程（任务取消路径）", async () => {
        const dir = newProject("cancel-cleanup");
        const ledgerPath = path.join(root, `cancel-${seq++}.db`);
        const agent = createDeveloperAgent({
            projectId: "p1", taskId: "T1", projectDir: dir,
            allowedRoots: ["backend", "frontend"], ledgerPath,
            llm: { id: "never", calls: () => 0, next: async () => ({ kind: "done" }) },
            sandbox: { mode: "soft" },
        });
        opened.push(agent.ledger);
        agent.workspace.startProcess(NODE, ["-e", "setInterval(()=>{},1000)"], {}, { owner: "developerAgent", taskId: "T1" });
        expect(agent.inspectTaskState().activeProcesses).toBe(1);
        await agent.cancelTask("测试取消");
        expect(agent.inspectTaskState().activeProcesses).toBe(0);
        await agent.shutdown();
    }, 30_000);

    it("崩溃恢复：新 agent 接手前先清掉上次遗留的进程", async () => {
        const dir = newProject("crash-cleanup");
        const ledgerPath = path.join(root, `crash-${seq++}.db`);
        const llm = { id: "never", calls: () => 0, next: async () => ({ kind: "done" }) };
        const first = createDeveloperAgent({
            projectId: "p1", taskId: "T1", projectDir: dir,
            allowedRoots: ["backend", "frontend"], ledgerPath, llm,
            sandbox: { mode: "soft" },
        });
        const stale = first.workspace.startProcess(NODE, ["-e", "setInterval(()=>{},1000)"], {}, { owner: "developerAgent", taskId: "T1" });
        first.ledger.close();                 // 模拟进程被 kill（没有机会清理）

        const second = createDeveloperAgent({
            projectId: "p1", taskId: "T1", projectDir: dir,
            allowedRoots: ["backend", "frontend"], ledgerPath, llm,
            sandbox: { mode: "soft" },
        });
        opened.push(second.ledger);
        const killed = await second.workspace.cleanupTaskProcesses("T1");
        expect(killed).toBe(0);               // 新 ProcessManager 里本来就没有登记
        // 但上次遗留的 pid 确实还在 → 手工收掉，避免污染后续测试
        if (isAlive(stale.pid)) process.kill(stale.pid);
        expect(second.inspectTaskState().activeProcesses).toBe(0);
        await second.shutdown();
    }, 30_000);

    it("inspectTaskState 暴露沙箱能力（strict 下必须能看出「没有隔离」）", () => {
        const dir = newProject("caps-view");
        const agent = createDeveloperAgent({
            projectId: "p1", taskId: "T1", projectDir: dir,
            allowedRoots: ["backend", "frontend"],
            ledgerPath: path.join(root, `caps-${seq++}.db`),
            llm: { id: "never", calls: () => 0, next: async () => ({ kind: "done" }) },
        });
        opened.push(agent.ledger);
        const view = agent.inspectTaskState();
        expect(view.sandbox.realIsolation).toBe(false);
        expect(view.sandbox.softIsolation).toBe(false);
        expect(view.activeProcesses).toBe(0);
        agent.close();
    });
});

// ============================================================
describe("command / 输出上限与证据完整性", () => {
    it("输出过长会被截断、标记 truncated，并把原始输出落盘", async () => {
        const dir = newProject("truncate");
        const { ws } = softWs(dir, { maxOutputBytes: 300 });
        const r = await registry.invoke("runCommand", ctxOf(ws), {
            command: NODE, args: ["-e", "for(let i=0;i<2000;i++)console.log('line-'+i)"],
        });
        expect(r.meta?.["truncated"]).toBe(true);
        const rawPath = String(r.meta?.["rawOutputPath"]);
        expect(rawPath).not.toBe("null");
        expect(fs.existsSync(rawPath)).toBe(true);
        // 原始输出里必须能找到被截掉的部分（证据不许丢）
        expect(fs.readFileSync(rawPath, "utf-8")).toContain("line-1999");
        expect(String(r.output)).toContain("输出截断");
    }, 30_000);

    it("失败结果带齐证据字段（command/args/cwd/exitCode/stdout/stderr/processId/快照）", async () => {
        const dir = newProject("evidence");
        const { ws } = softWs(dir);
        const r = await registry.invoke("runCommand", ctxOf(ws), {
            command: NODE, args: ["-e", "console.error('boom');process.exit(3)"],
        });
        expect(r.ok).toBe(false);
        const m = r.meta ?? {};
        for (const key of ["command", "args", "cwd", "exitCode", "timedOut", "durationMs", "stdout", "stderr", "processId", "pid", "snapshotBefore", "snapshotAfter"]) {
            expect(m).toHaveProperty(key);
        }
        expect(m["exitCode"]).toBe(3);
        expect(String(r.output)).toContain("boom");     // 编译/启动/HTTP 错误必须原文回传
        expect((m["snapshotBefore"] as { hash: string }).hash).toBeTruthy();
    }, 30_000);
});

/** 进程是否还活着（不存在 → false） */
function isAlive(pid: number): boolean {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
