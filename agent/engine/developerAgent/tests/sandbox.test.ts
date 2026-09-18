// tests/sandbox.test.ts —— 命令执行的隔离边界（零 LLM）
//
//   覆盖规格第九节里"隔离与边界"那几条：
//     10 敏感环境变量不会传入子进程
//     11 路径逃逸会被拒绝
//     12 访问 .git / Ledger / 契约 / 验收文件会被拒绝
//     13 TestAgent 调用 Developer shell 会被拒绝
//     14 同一文件快照下重复命令不会重复执行
//     15 进程在任务结束与崩溃恢复后都会清理
//     16 无真实沙箱时返回 SANDBOX_UNAVAILABLE，而不是执行宿主命令
//
//   这里一律用 `sandbox: { mode: "soft" }` —— 显式开启的软档。
//   软档不是隔离：tests 里用它是为了能在本机真跑命令，不代表生产可以这么开。
import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../workspace";
import { DeveloperLedger } from "../ledger";
import {
    createFullDeveloperToolRegistry, DEVELOPER_ROLE_NAME,
    EXEC_TOOLS, PRIVILEGED_TOOLS, READONLY_TOOL_NAMES,
} from "../tools/registry";
import type { ToolContext } from "../tools/registry";
import { createTestAgentToolbox } from "../tools/testAssistant";
import {
    commandKeyOf, integrityDeltas, resolveSandboxCapabilities, sanitizeEnv,
} from "../tools/processSandbox";
import { invokeWithFingerprintCache, SNAPSHOT_KEYED_TOOLS, toolCallFingerprint } from "../graph";
import { cleanupTempDirsAfterTests, tmpDir } from "./_tmp";

const root = tmpDir("cf-dev-sandbox");
const NODE = process.execPath;
const opened: DeveloperLedger[] = [];
let seq = 0;

// 清理分两步，**顺序不能反**（9/17 实测）：
//   ① 先关账本 —— 这些用例建的是真 sqlite，Windows 上开着库删树必 EBUSY
//      （实测报错就是 `EBUSY: resource busy or locked`；db.close() 之后同一条 rmSync 立刻成功）；
//   ② 再交给 _tmp.ts 删树 —— 它带重试/退避，并且给 afterAll 传 60 秒超时
//      （删树要好几秒，默认 5 秒会把收尾变成"钩子超时"；老注释里"临时目录交给系统清理"
//       的那个妥协，就是被这一步替掉的）。bun 的钩子按注册顺序执行，所以清理钩子必须
//       注册在下面这个 afterAll **之后**。
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

function softWorkspace(projectDir: string, o: {
    maxOutputBytes?: number;
    watchIntervalMs?: number;
    protectedPaths?: string[];
    ledger?: DeveloperLedger;
} = {}): Workspace {
    const ledger = o.ledger ?? DeveloperLedger.open(path.join(root, `sb-${seq++}.db`), "p1:t1");
    if (!opened.includes(ledger)) opened.push(ledger);
    return new Workspace({
        projectDir,
        allowedRoots: ["backend", "frontend"],
        sandbox: {
            mode: "soft",
            maxOutputBytes: o.maxOutputBytes ?? 256 * 1024,
            watchIntervalMs: o.watchIntervalMs ?? 200,
        },
        ledgerIntegrity: () => ledger.integrityCounters(),
        ...(o.protectedPaths ? { protectedPaths: o.protectedPaths } : {}),
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
}

function devCtx(ws: Workspace, role = DEVELOPER_ROLE_NAME): ToolContext {
    return { workspace: ws, owner: "developerAgent", role, taskId: "T1" };
}

const registry = createFullDeveloperToolRegistry();

// ============================================================
describe("sandbox / 能力探测（没有隔离后端就不执行）", () => {
    it("strict + backend=none → realIsolation=false 且 softIsolation=false", () => {
        const caps = resolveSandboxCapabilities({ mode: "strict", backend: "none" });
        expect(caps.realIsolation).toBe(false);
        expect(caps.softIsolation).toBe(false);
        expect(caps.backend).toBe("none");
        expect(caps.reasons.length).toBeGreaterThan(0);
        expect(caps.reasons.join("；")).toContain("禁止在宿主机上开放无限制 Shell");
    });

    it("显式 soft → softIsolation=true，但 realIsolation 仍然是 false（不许冒充隔离）", () => {
        const caps = resolveSandboxCapabilities({ mode: "soft" });
        expect(caps.softIsolation).toBe(true);
        expect(caps.realIsolation).toBe(false);
        expect(caps.limitations.join("；")).toContain("cwd 不是沙箱");
    });

    it("docker 后端：守护进程不可用 → 依然不给隔离能力", () => {
        const caps = resolveSandboxCapabilities({
            mode: "strict", backend: "docker",
            docker: { image: "node:22", probe: () => false },
        });
        expect(caps.realIsolation).toBe(false);
        expect(caps.reasons.join("；")).toContain("Docker");
    });

    it("docker 后端：探测通过才算真隔离", () => {
        const caps = resolveSandboxCapabilities({
            mode: "strict", backend: "docker",
            docker: { image: "node:22", probe: () => true },
        });
        expect(caps.realIsolation).toBe(true);
        expect(caps.softIsolation).toBe(false);
    });

    it("默认 sandbox 不可用时 runCommand 返回结构化 SANDBOX_UNAVAILABLE，且**真的没执行**", async () => {
        const dir = newProject("no-sandbox");
        // 关键：不传 sandbox 配置 = 默认 strict/backend=none
        const ws = new Workspace({ projectDir: dir, allowedRoots: ["backend", "frontend"] });
        const marker = path.join(dir, "must-not-exist.txt");
        const r = await registry.invoke("runCommand", devCtx(ws), {
            command: NODE, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`],
        });
        expect(r.ok).toBe(false);
        expect(r.rejected?.code).toBe("SANDBOX_UNAVAILABLE");
        expect(fs.existsSync(marker)).toBe(false);      // ★ 宿主命令没有被执行
    });
});

// ============================================================
describe("sandbox / 环境变量清洗", () => {
    it("密钥类变量被删掉，只记名字不记值", () => {
        const out = sanitizeEnv({
            PATH: "/usr/bin", HOME: "/home/x",
            DEEPSEEK_API_KEY: "sk-secret", OPENAI_API_KEY: "sk-x",
            DATABASE_PASSWORD: "pw", AWS_SECRET_ACCESS_KEY: "s",
            SSH_PRIVATE_KEY: "-----BEGIN", MY_TOKEN: "t", GITHUB_TOKEN: "g",
            NODE_OPTIONS: "--inspect",
        });
        expect(out.env["DEEPSEEK_API_KEY"]).toBeUndefined();
        expect(out.env["OPENAI_API_KEY"]).toBeUndefined();
        expect(out.env["DATABASE_PASSWORD"]).toBeUndefined();
        expect(out.env["SSH_PRIVATE_KEY"]).toBeUndefined();
        expect(out.env["MY_TOKEN"]).toBeUndefined();
        expect(out.removed).toContain("DEEPSEEK_API_KEY");
        expect(out.env["PATH"]).toBe("/usr/bin");
        // 只记名字：返回值里不能出现任何密钥的**值**
        expect(JSON.stringify(out)).not.toContain("sk-secret");
    });

    it("显式透传的安全变量可以进，但密钥类的白名单也盖不住", () => {
        const out = sanitizeEnv(
            { SAFE_FLAG: "1", DEEPSEEK_API_KEY: "sk-secret" },
            { passthrough: ["DEEPSEEK_API_KEY"], extra: { APP_MODE: "test" } },
        );
        expect(out.env["SAFE_FLAG"]).toBe("1");
        expect(out.env["APP_MODE"]).toBe("test");
        expect(out.env["DEEPSEEK_API_KEY"]).toBeUndefined();
        expect(out.removed).toContain("DEEPSEEK_API_KEY");
    });

    it("真跑一条命令：子进程里读不到宿主的 API Key", async () => {
        const dir = newProject("env-leak");
        const ws = softWorkspace(dir);
        process.env["DEEPSEEK_API_KEY"] = "sk-must-not-leak";
        process.env["DATABASE_PASSWORD"] = "pw-must-not-leak";
        try {
            const r = await registry.invoke("runCommand", devCtx(ws), {
                command: NODE,
                args: ["-e", "console.log(JSON.stringify({k:process.env.DEEPSEEK_API_KEY??null,p:process.env.DATABASE_PASSWORD??null}))"],
            });
            expect(r.ok).toBe(true);
            expect(r.output).toContain('"k":null');
            expect(r.output).toContain('"p":null');
            expect(r.output).not.toContain("sk-must-not-leak");
            expect((r.meta?.["envRemoved"] as string[]).length).toBeGreaterThan(0);
        } finally {
            delete process.env["DEEPSEEK_API_KEY"];
            delete process.env["DATABASE_PASSWORD"];
        }
    });

    it("命令键归一化：路径与扩展名不影响部署策略比对", () => {
        expect(commandKeyOf("./mvnw.cmd")).toBe("mvnw");
        expect(commandKeyOf("C:\\\\tools\\\\node.exe")).toBe("node");
        expect(commandKeyOf("bash")).toBe("bash");
    });
});

// ============================================================
describe("sandbox / 路径与写保护边界", () => {
    it("cwd 逃出项目根 → 拒绝（PATH_ESCAPE）", async () => {
        const dir = newProject("escape");
        const ws = softWorkspace(dir);
        const r = await registry.invoke("runCommand", devCtx(ws), {
            command: NODE, args: ["-e", "console.log(1)"], cwd: "../..",
        });
        expect(r.ok).toBe(false);
        expect(r.output).toContain("ESCAPE");
    });

    it("cwd 绝对路径越界 → 拒绝", async () => {
        const dir = newProject("escape-abs");
        const ws = softWorkspace(dir);
        await expect(ws.exec(NODE, ["-e", "1"], { cwd: os.tmpdir() })).rejects.toThrow(/ESCAPE/);
    });

    it("写 .git → 被判定为项目外写入并留违规证据", async () => {
        const dir = newProject("git-write");
        fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
        fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
        const ledger = DeveloperLedger.open(path.join(root, `git-${seq++}.db`), "p1:t1");
        opened.push(ledger);
        const ws = softWorkspace(dir, { ledger, watchIntervalMs: 150 });

        const r = await ws.exec(NODE, ["-e", "require('fs').writeFileSync('.git/evil','x')"]);
        expect(r.violations?.some((v) => v.code === "OUT_OF_PROJECT_WRITE")).toBe(true);
        expect(ledger.listViolations().length).toBeGreaterThan(0);
    }, 20_000);

    it("改写 CONTRACTS.md → 被判定为项目外写入", async () => {
        const dir = newProject("contract-write");
        fs.writeFileSync(path.join(dir, "CONTRACTS.md"), "# 契约\n");
        const ws = softWorkspace(dir);
        const r = await ws.exec(NODE, ["-e", "require('fs').writeFileSync('CONTRACTS.md','hacked')"]);
        expect(r.violations?.some((v) => v.code === "OUT_OF_PROJECT_WRITE")).toBe(true);
    }, 20_000);

    it("改写 acceptance-*.json → 被判定为项目外写入", async () => {
        const dir = newProject("acceptance-write");
        fs.writeFileSync(path.join(dir, "acceptance-p1.json"), '{"checks":[]}\n');
        const ws = softWorkspace(dir);
        const r = await ws.exec(NODE, ["-e", "require('fs').writeFileSync('acceptance-p1.json','{\"checks\":[1]}')"]);
        expect(r.violations?.some((v) => v.message.includes("acceptance-p1.json"))).toBe(true);
    }, 20_000);

    it("文件工具路径：.git / CONTRACTS.md / acceptance / 测试脚本 / 越界一律拒绝", () => {
        const dir = newProject("write-gate");
        const ws = softWorkspace(dir);
        const meta = { owner: "developerAgent", taskId: "T1" };
        const code = (fn: () => unknown): string => {
            try { fn(); return "NO_THROW"; } catch (e) { return (e as { code?: string }).code ?? "ERR"; }
        };
        expect(code(() => ws.writeAtomic("backend/.git/config", "x", meta))).toBe("GIT");
        expect(code(() => ws.writeAtomic("backend/CONTRACTS.md", "x", meta))).toBe("CONTRACT");
        expect(code(() => ws.writeAtomic("backend/acceptance-p1.json", "x", meta))).toBe("ACCEPTANCE");
        expect(code(() => ws.writeAtomic("backend/src/A.test.ts", "x", meta))).toBe("TEST_SCRIPT");
        expect(code(() => ws.writeAtomic("../evil.txt", "x", meta))).toBe("ESCAPE");
        expect(code(() => ws.writeAtomic("docs/readme.md", "x", meta))).toBe("NOT_IN_ALLOWED_ROOTS");
        // 控制平面自身源码：即便 projectDir 被误配到控制平面里也拦得住
        expect(ws.checkPath(path.resolve(import.meta.dir, "..", "workspace.ts"))).toBe("CONTROL_PLANE");
    });

    it("projectDir 落在控制平面内（9/16 团队线 runs/pXX 的真实形态）→ 项目内放行，引擎文件仍 CONTROL_PLANE", () => {
        // 9/16 p20 首跑母病：checkPath 把 CONTROL_PLANE 判在项目根包含检查之前，
        // 而团队线产物树 runs/pXX 就住在 agents-CrewForge/ 里 → 全项目路径被误判，
        // 11 个工具调用 0 通过、改盘 0 个文件。修复 = 先问「在项目内吗」再问「碰引擎了吗」。
        const cpRoot = path.resolve(import.meta.dir, "..", "..");   // agents-CrewForge/
        const projDir = path.join(cpRoot, "runs", "p999");          // 纯路径算术，不真建目录
        const ws = new Workspace({ projectDir: projDir, allowedRoots: ["backend", "frontend"] });
        // 项目内：放行（这才是生成项目的日常路径）
        expect(ws.checkPath(path.join(projDir, "backend", "src", "main", "App.java"))).toBeNull();
        expect(ws.resolveRead("backend")).toBe(path.join(projDir, "backend"));
        // 项目内命中内置禁区：按项目语义判码，而不是退化成 CONTROL_PLANE
        expect(ws.checkPath(path.join(projDir, ".git", "config"))).toBe("GIT");
        // 越出项目、落进引擎地盘：仍 CONTROL_PLANE（控制平面保护不降级）
        expect(ws.checkPath(path.join(cpRoot, "architect.ts"))).toBe("CONTROL_PLANE");
        // 既不在项目也不在控制平面：ESCAPE 不变
        expect(ws.checkPath(path.resolve(root, "..", "outside.txt"))).toBe("ESCAPE");
    });

    it("子进程删改 Ledger 行 → 完整性探针发现计数下降并留违规", async () => {
        const dir = newProject("ledger-tamper");
        const ledgerPath = path.join(dir, "ledger.db");
        const ledger = DeveloperLedger.open(ledgerPath, "p1:t1");
        opened.push(ledger);
        ledger.appendEvent("seed", { a: 1 });
        ledger.appendEvent("seed", { a: 2 });
        const ws = softWorkspace(dir, { ledger });

        const before = ledger.integrityCounters()["ledger:event"] ?? 0;
        expect(before).toBeGreaterThanOrEqual(2);

        // 先用一条"什么也不干"的命令确认不会误报
        const clean = await ws.exec(NODE, ["-e", "console.log('noop')"]);
        expect(clean.violations ?? []).toEqual([]);

        // 真的删行（用 bun:sqlite，模拟子进程删改 Ledger）
        const tamper = await ws.exec("bun", [
            "-e", `const {Database}=require('bun:sqlite');const db=new Database(${JSON.stringify(ledgerPath)});db.exec('DELETE FROM event');`,
        ], { timeoutMs: 60_000 });
        expect(tamper.violations?.some((v) => v.message.includes("ledger:event"))).toBe(true);
        expect(ledger.listViolations().some((v) => v.message.includes("ledger:event"))).toBe(true);
    }, 60_000);

    it("integrityDeltas 只把「下降」判成违规", () => {
        expect(integrityDeltas({ a: 3 }, { a: 2 })).toEqual([{ key: "a", before: 3, after: 2 }]);
        expect(integrityDeltas({ a: 2 }, { a: 3 })).toEqual([]);   // 上升 = 正常写入
        expect(integrityDeltas({ a: 2 }, {})).toEqual([{ key: "a", before: 2, after: -1 }]); // 整表消失
    });
});

// ============================================================
describe("sandbox / 角色闸门", () => {
    it("TestAgent 角色调用 shell / startProcess / httpRequest 一律被拒", async () => {
        const dir = newProject("role-gate");
        const ws = softWorkspace(dir);
        for (const tool of ["shell", "startProcess", "httpRequest", "runCommand", "runBuild"]) {
            const r = await registry.invoke(tool, devCtx(ws, "test"), { command: "echo", url: "http://127.0.0.1:1/" });
            expect(r.ok).toBe(false);
            expect(r.rejected?.code).toBe("NOT_DEVELOPER");
        }
        for (const role of ["pm", "architect", "document"]) {
            const r = await registry.invoke("shell", devCtx(ws, role), { command: "echo hi" });
            expect(r.ok).toBe(false);
            expect(r.rejected?.code).toBe("NOT_DEVELOPER");
        }
    });

    it("TestAgent 工具盒在**工具名层面**就摸不到 Developer 的 shell", async () => {
        const dir = newProject("test-toolbox");
        const ws = softWorkspace(dir);
        const box = createTestAgentToolbox({ workspace: ws, tools: registry, taskId: "T1" });
        for (const tool of ["shell", "runCommand", "runBuild", "startProcess", "readProcess", "stopProcess", "httpRequest", "writeFile"]) {
            const r = await box.invoke(tool, { command: "echo hi" });
            expect(r.ok).toBe(false);
            expect(r.rejected?.code).toBe("NOT_READONLY");
        }
        // 只读工具仍然可用
        expect((await box.invoke("inspectTree", {})).ok).toBe(true);
    });

    it("Developer 自己仍然能拿到完整工具集（shell/httpRequest/进程三件套都在）", () => {
        const names = registry.names();
        for (const n of ["shell", "httpRequest", "startProcess", "readProcess", "stopProcess", "runCommand", "runBuild"]) {
            expect(names).toContain(n);
        }
    });

    it("runAcceptance（验收预演）必须始终对 Developer 可用——它是 r5 验证税的靶向补丁", () => {
        // r5 实测：145 次调用里 116 次（80%）发生在施工结束之后，25 次是模型手写
        // selftest-*.mjs 自证。这个工具就是拿去替那段流程的；它一旦不在工具集里，
        // 模型会退回到"自己写脚本"，验证税立刻回来。
        expect(registry.names()).toContain("runAcceptance");
    });

    it("runAcceptance 是特权工具：非 Developer 角色一律拒绝（它会真起服务/跑命令）", async () => {
        expect(EXEC_TOOLS.has("runAcceptance")).toBe(true);
        expect(PRIVILEGED_TOOLS.has("runAcceptance")).toBe(true);
        // 只读子 Agent 的工具盒里不该有它
        expect(READONLY_TOOL_NAMES).not.toContain("runAcceptance");
    });
});

// ============================================================
describe("sandbox / 命令指纹与去重", () => {
    it("指纹构成：执行类工具带文件快照，非执行工具不带", () => {
        const base = { taskId: "T1" };
        const a = toolCallFingerprint({ ...base, tool: "runBuild", args: { target: "frontend" }, snapshotHash: "s1" });
        const b = toolCallFingerprint({ ...base, tool: "runBuild", args: { target: "frontend" }, snapshotHash: "s2" });
        expect(a).not.toBe(b);                                  // 文件变了 → 指纹变 → 可以重跑
        expect(toolCallFingerprint({ ...base, tool: "runBuild", args: { target: "frontend" }, snapshotHash: "s1" })).toBe(a);

        const w1 = toolCallFingerprint({ ...base, tool: "writeFile", args: { path: "backend/A.java", content: "x" } });
        const w2 = toolCallFingerprint({ ...base, tool: "writeFile", args: { path: "backend/A.java", content: "x" } });
        expect(w1).toBe(w2);                                    // 与既有恢复语义完全一致
        expect(SNAPSHOT_KEYED_TOOLS.has("writeFile")).toBe(false);
    });

    it("同一文件快照下，重复命令不重复执行；文件变了才重跑", async () => {
        const dir = newProject("dedupe");
        const ledger = DeveloperLedger.open(path.join(root, `dd-${seq++}.db`), "p1:t1");
        opened.push(ledger);
        const ws = softWorkspace(dir, { ledger });

        let realRuns = 0;
        const spy = {
            describe: () => [],
            names: () => [],
            invoke: async (name: string, ctx: ToolContext, args: Record<string, unknown>) => {
                realRuns++;
                return registry.invoke(name, ctx, args as never);
            },
        } as unknown as import("../tools/registry").ToolRegistry;

        const ctx = devCtx(ws);
        const call = () => invokeWithFingerprintCache({
            tools: spy, ctx, ledger, tool: "runCommand",
            args: { command: NODE, args: ["-e", "console.log('built')"] },
        });

        const first = await call();
        expect(first.cached).toBe(false);
        expect(first.result.ok).toBe(true);
        expect(realRuns).toBe(1);

        const second = await call();                            // 快照没变 → 复用
        expect(second.cached).toBe(true);
        expect(realRuns).toBe(1);
        expect(second.result.output).toContain("缓存复用");

        ws.writeAtomic("backend/Changed.java", "class Changed {}", { owner: "developerAgent", taskId: "T1" });
        const third = await call();                             // 快照变了 → 真的重跑
        expect(third.cached).toBe(false);
        expect(realRuns).toBe(2);
    }, 30_000);

    it("httpRequest / startProcess 永不缓存（缓存等于伪造验证结果）", async () => {
        const dir = newProject("never-cache");
        const ledger = DeveloperLedger.open(path.join(root, `nc-${seq++}.db`), "p1:t1");
        opened.push(ledger);
        const ws = softWorkspace(dir, { ledger });
        let runs = 0;
        const spy = {
            describe: () => [], names: () => [],
            invoke: async () => { runs++; return { ok: true, output: "ok" }; },
        } as unknown as import("../tools/registry").ToolRegistry;

        const ctx = devCtx(ws);
        for (const tool of ["httpRequest", "startProcess", "readProcess", "stopProcess"] as const) {
            await invokeWithFingerprintCache({ tools: spy, ctx, ledger, tool, args: { url: "http://127.0.0.1:1/" } });
            await invokeWithFingerprintCache({ tools: spy, ctx, ledger, tool, args: { url: "http://127.0.0.1:1/" } });
        }
        expect(runs).toBe(8);                                   // 每次都真的调用
    });
});
