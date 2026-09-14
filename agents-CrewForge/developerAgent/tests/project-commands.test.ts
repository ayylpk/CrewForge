// tests/project-commands.test.ts —— 9/13 去 Maven 硬编码的回归测试（零 LLM）
//
//   背景：graph.ts 本地自检曾把 backend 写死为 mvnw.cmd，Express/TS 项目被
//   "证据为空的 COMPILE 失败"拖进修复死循环。本文件钉死新行为：
//     ① resolveProjectCommand 按工程文件识别（mvnw/gradlew/package.json/pyproject/go.mod），
//        识别不到返回 null，绝不猜；
//     ② runBuild 用同一解析器，NO_BUILD_ENTRY 是结构化结果（不执行、不通过）；
//     ③ 门禁：NO_BUILD_ENTRY → 未验证分支（不触发编译修复、test_request 标注），
//        真实编译失败 → 仍走修复且**带证据**；目录不存在/任务没声明 → 跳过。
import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveProjectCommand, NO_BUILD_ENTRY } from "../tools/projectCommands";
import { runBuildTool } from "../tools/runBuild";
import type { ToolContext } from "../tools/registry";
import { buildDeveloperGraph, routeAfterLocalChecks } from "../graph";
import type { DeveloperLlm, MessagePort } from "../graph";
import { DeveloperLedger } from "../ledger";
import { Workspace } from "../workspace";
import { initialDeveloperState } from "../state";
import type { DeveloperState } from "../state";
import type { ToolArgs, ToolRegistry } from "../tools/registry";
import type { ArchitectTask, OutboundMessage } from "../protocol";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-dev-projcmd-"));
const opened: DeveloperLedger[] = [];
let seq = 0;
// afterAll 要给足时间：这里建的是**真 sqlite（含 WAL）**，Windows 上删树实测能到 6s+，
// 默认 5s 钩子预算会被打爆（sandbox.test.ts 里同样的坑有记录）。清理是有意义的，
// 所以改成显式放宽预算，而不是像 sandbox 那样干脆不清理。
afterAll(() => {
    for (const l of opened) { try { l.close(); } catch { /* 已关 */ } }
    fs.rmSync(root, { recursive: true, force: true });
}, 30_000);

function mk(name: string, files: Record<string, string> = {}): string {
    const dir = path.join(root, name);
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }
    fs.mkdirSync(path.join(dir, "backend"), { recursive: true });
    fs.mkdirSync(path.join(dir, "frontend"), { recursive: true });
    return dir;
}

// ============================================================
// 一、解析器：认工程文件，不认框架
// ============================================================

describe("projectCommands / resolveProjectCommand", () => {
    it("Express+TS：package.json scripts.build → npm run build（绝不碰 mvnw）", () => {
        const dir = mk("pc-express", { "backend/package.json": JSON.stringify({ scripts: { build: "tsc", dev: "tsx watch ." } }) });
        const r = resolveProjectCommand(path.join(dir, "backend"));
        expect(r).not.toBeNull();
        expect(r!.command).toBe("npm");
        expect(r!.args).toEqual(["run", "build"]);
        expect(r!.detectedBy).toBe("package.json.scripts.build");
    });

    it("只有 dev/start 脚本 → 不当构建命令用（返回 null，不猜）", () => {
        const dir = mk("pc-devonly", { "backend/package.json": JSON.stringify({ scripts: { start: "node .", dev: "nodemon ." } }) });
        expect(resolveProjectCommand(path.join(dir, "backend"))).toBeNull();
    });

    it("scripts.compile 是 build 的次选", () => {
        const dir = mk("pc-compile", { "backend/package.json": JSON.stringify({ scripts: { compile: "tsc" } }) });
        expect(resolveProjectCommand(path.join(dir, "backend"))?.detectedBy).toBe("package.json.scripts.compile");
    });

    it("Spring Boot：mvnw.cmd → Maven Wrapper（Windows）；Unix 下选 mvnw", () => {
        const dir = mk("pc-spring", { "backend/mvnw.cmd": "@echo off", "backend/mvnw": "#!/bin/sh" });
        expect(resolveProjectCommand(path.join(dir, "backend"), { isWin: true })).toEqual(
            { command: "mvnw.cmd", args: ["-q", "package", "-DskipTests"], detectedBy: "maven-wrapper" });
        expect(resolveProjectCommand(path.join(dir, "backend"), { isWin: false })!.command).toBe("mvnw");
    });

    it("Gradle：gradlew.bat → build -x test", () => {
        const dir = mk("pc-gradle", { "backend/gradlew.bat": "@echo off" });
        const r = resolveProjectCommand(path.join(dir, "backend"), { isWin: true });
        expect(r!.command).toBe("gradlew.bat");
        expect(r!.args).toEqual(["build", "-x", "test"]);
        expect(r!.detectedBy).toBe("gradle-wrapper");
    });

    it("Python：pyproject.toml → python -m compileall；Go：go.mod → go build ./...", () => {
        const py = mk("pc-py", { "backend/pyproject.toml": "[project]" });
        expect(resolveProjectCommand(path.join(py, "backend"))!.detectedBy).toBe("python-project");
        const go = mk("pc-go", { "backend/go.mod": "module x" });
        expect(resolveProjectCommand(path.join(go, "backend"))!.command).toBe("go");
    });

    it("空目录 → null（调用方转 NO_BUILD_ENTRY，未验证≠通过）", () => {
        const dir = mk("pc-empty");
        expect(resolveProjectCommand(path.join(dir, "backend"))).toBeNull();
    });

    it("Maven Wrapper 优先级高于 package.json（混合仓库不静默换栈）", () => {
        const dir = mk("pc-prio", {
            "backend/mvnw.cmd": "@echo off",
            "backend/package.json": JSON.stringify({ scripts: { build: "tsc" } }),
        });
        expect(resolveProjectCommand(path.join(dir, "backend"), { isWin: true })!.detectedBy).toBe("maven-wrapper");
    });
});

// ============================================================
// 二、runBuild 工具：解析 → 执行记录（mock exec，不真跑 npm）
// ============================================================

function mockCtx(projectDir: string): { ctx: ToolContext; calls: { command: string; args: string[]; cwd: string }[] } {
    const calls: { command: string; args: string[]; cwd: string }[] = [];
    const ws = {
        projectDir,
        sandboxCapabilities: { timeouts: { buildMs: 60_000 } },
        exec: async (command: string, args: string[], o: { cwd: string }) => {
            calls.push({ command, args, cwd: o.cwd });
            return {
                cwd: o.cwd, exitCode: 0, timedOut: false, durationMs: 1,
                stdout: "", stderr: "", violations: [],
                realIsolation: false, softIsolation: true, sandboxMode: "soft", sandboxBackend: "local",
            };
        },
    };
    return { ctx: { workspace: ws, owner: "test", role: "developer", taskId: "T1" } as unknown as ToolContext, calls };
}

describe("projectCommands / runBuild 工具", () => {
    it("backend=Express 时执行 npm run build（不是 mvnw.cmd）", async () => {
        const dir = mk("rb-express", { "backend/package.json": JSON.stringify({ scripts: { build: "tsc" } }) });
        const { ctx, calls } = mockCtx(dir);
        const r = await runBuildTool.run(ctx, { target: "backend" } as ToolArgs);
        expect(r.ok).toBe(true);
        expect(calls).toEqual([{ command: "npm", args: ["run", "build"], cwd: "backend" }]);
        expect(r.meta?.["detectedBy"]).toBe("package.json.scripts.build");
    });

    it("backend=Spring Boot 时执行 mvnw.cmd（保留旧能力，靠的是识别不是写死）", async () => {
        const dir = mk("rb-spring", { "backend/mvnw.cmd": "@echo off" });
        const { ctx, calls } = mockCtx(dir);
        const r = await runBuildTool.run(ctx, { target: "backend" } as ToolArgs);
        expect(r.ok).toBe(true);
        expect(calls[0]!.command).toBe(process.platform === "win32" ? "mvnw.cmd" : "mvnw");
    });

    it("NO_BUILD_ENTRY：ok=false、零执行、结构化 code", async () => {
        const dir = mk("rb-none");
        const { ctx, calls } = mockCtx(dir);
        const r = await runBuildTool.run(ctx, { target: "backend" } as ToolArgs);
        expect(r.ok).toBe(false);
        expect(calls.length).toBe(0);                       // ★ 没执行任何猜测命令
        expect(r.meta?.["code"]).toBe(NO_BUILD_ENTRY);
        expect(r.meta?.["exitCode"]).toBeNull();            // ★ 没跑 ≠ 跑过且为 0
    });
});

// ============================================================
// 三、graph 本地自检门禁（Fake 注册表，零执行零 LLM）
// ============================================================

const DONE = { kind: "done" };
/** 捕获每次喂给 LLM 的 task 文本——修复提示词必须带证据（9/13 renderRepair 白卷回归） */
function captureLlm() {
    const prompts: string[] = [];
    const llm: DeveloperLlm = {
        id: "q",
        calls: () => prompts.length,
        next: async (input) => { prompts.push(input.task); return DONE; },
    };
    return { llm, prompts };
}

const task: ArchitectTask = {
    type: "architect_task", projectId: "p", taskId: "t",
    requirementSnapshot: { goal: "g" }, stackProfile: { frontend: "vue3", backend: "express" },
    domainModel: { entity: "note" }, contract: { version: "1", endpoints: [] },
    foundationPlan: { dirs: ["backend", "frontend"] },
    allowedRoots: ["backend", "frontend"], forbiddenPaths: [],
    acceptanceChecks: [], developerInstructions: "x",
};

function gateTools(o: {
    mode: "pass" | "no_entry" | "fail";
    invoked: string[];
}): ToolRegistry {
    return {
        describe: () => [], names: () => [],
        invoke: async (name: string, _c: ToolContext, args: ToolArgs) => {
            o.invoked.push(`${name}:${String(args["target"] ?? args["path"] ?? "")}`);
            if (name === "inspectTree") return { ok: true, output: "tree", meta: { total: 1 } };
            if (name === "runBuild") {
                if (o.mode === "pass") return { ok: true, output: "[build] exit=0", meta: { exitCode: 0, detectedBy: "package.json.scripts.build" } };
                if (o.mode === "no_entry") return { ok: false, output: "[build] NO_BUILD_ENTRY：没有可识别的通用工程入口", meta: { code: NO_BUILD_ENTRY, exitCode: null } };
                return { ok: false, output: "[build] exit=1 error TS2304: Cannot find name 'foo'", meta: { exitCode: 1 } };
            }
            return { ok: true, output: "ok" };
        },
    } as unknown as ToolRegistry;
}

async function runGate(projectDir: string, mode: "pass" | "no_entry" | "fail") {
    const invoked: string[] = [];
    const ledger = DeveloperLedger.open(path.join(root, `gate-${seq++}.db`), "p:t");
    opened.push(ledger);
    const sent: OutboundMessage[] = [];
    const port: MessagePort = {
        send: (_t, m) => { sent.push(m); return "wake"; },
        receive: async () => ({ status: "invalid", error: "无消息", sender: null }),
    };
    const ws = new Workspace({ projectDir, allowedRoots: ["backend", "frontend"] });
    const { llm, prompts } = captureLlm();
    const graph = buildDeveloperGraph({
        workspace: ws, tools: gateTools({ mode, invoked }), ledger, port, llm,
        trustedTestAgents: ["test-core"],
    });
    const final = await graph.invoke(initialDeveloperState({
        projectId: "p", taskId: "t", runId: "r", projectDir,
        allowedRoots: ["backend", "frontend"], messages: [task],
    })) as DeveloperState;
    return { final, invoked, sent, ledger, prompts };
}

describe("projectCommands / graph 本地自检", () => {
    it("Express 任务：门禁调 runBuild（内部识别 npm），全程不出现 mvnw 字样", async () => {
        const dir = mk("gate-express", {
            "backend/package.json": JSON.stringify({ scripts: { build: "tsc" } }),
            "frontend/package.json": JSON.stringify({ scripts: { build: "vite build" } }),
        });
        const { final, invoked } = await runGate(dir, "pass");
        expect(final.status).toBe("waiting_test");
        expect(invoked.filter((x) => x.startsWith("runBuild:")).sort())
            .toEqual(["runBuild:backend", "runBuild:frontend"]);
        expect(JSON.stringify(invoked)).not.toContain("mvnw");
    });

    it("NO_BUILD_ENTRY：不触发编译修复、不伪造成功——照常送检并标注未验证", async () => {
        const dir = mk("gate-noentry");   // backend/frontend 空目录
        const { final, sent, ledger } = await runGate(dir, "no_entry");
        expect(final.status).toBe("waiting_test");      // ★ 没进 repair、没 blocked
        expect(final.repairAttempts).toBe(0);           // ★ 不消耗修复预算（9/13 的死因）
        expect(final.error).toBeNull();                 // 不是编译错误
        expect(final.localChecksUnverified.sort()).toEqual(["backend", "frontend"]);
        const req = sent.find((m) => m.type === "test_request");
        expect((req as { reason?: string } | undefined)?.reason).toContain("NO_BUILD_ENTRY");
        expect(ledger.listEvents().filter((e) => e.type === "local_check_no_build_entry").length).toBe(2);
    });

    it("真实编译失败：仍然进修复（有 repair_started），错误带真实证据", async () => {
        const dir = mk("gate-fail", { "backend/package.json": "{}", "frontend/package.json": "{}" });
        const { final, sent, prompts } = await runGate(dir, "fail");
        // Fake 修复一轮没改任何文件 → stalled 闸收口 blocked；关键是它**进了修复回路**
        expect(sent.some((m) => m.type === "repair_started")).toBe(true);
        expect(final.status).toBe("blocked");
        // 9/13 空证据教训：错误与**修复提示词**都必须携带可排查的构建输出
        expect(String(final.error ?? "")).toContain("TS2304");
        const repairPrompt = prompts.find((p) => p.includes("runBuild（本地预检门禁）"));
        expect(repairPrompt).toBeDefined();
        expect(repairPrompt!).toContain("TS2304");
    });

    it("routeAfterLocalChecks 纯函数：只有 NO_BUILD_ENTRY（error=null）→ requestTest 不是 repair", () => {
        const s = initialDeveloperState({
            status: "implementing", error: null, localChecksUnverified: ["backend"],
        });
        expect(routeAfterLocalChecks(s)).toBe("requestTest");
    });
});
