// ============================================================
// tests/windows-cmd-spawn.test.ts —— Windows 上「命令真能起来」的回归钉
//
//   ── 为什么必须有这个文件（s4d-todo-lite / p33 实弹）──
//   `启动失败（npm run build @ frontend）：ENOENT: no such file or directory,
//    uv_spawn 'npm'` —— 预演连构建都**起不来**（exit=null / 3ms），于是
//   Developer 无法自证，78/78 预算烧光、修复轮 0、终态 blocked。
//   真因见 tools/winCmd.ts 文件头（本机实测：给 Bun.spawn 传了 env 之后，
//   裸名 `npm` 不做 PATHEXT 展开 → ENOENT）。
//
//   ★ 本文件**不 mock 执行层**：真的建一个 frontend 工程、真的跑 `npm run build`、
//     真的断言退出码 0 与 stdout 里的构建输出。这是"预演能开始也能结束"的验收判据。
// ============================================================
import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Workspace } from "../workspace";
import { resolveProjectCommand } from "../tools/projectCommands";
import {
    needsWindowsCmdForward, resolveLocalCmdShim, toSpawnArgv, withResolvablePathKey,
} from "../tools/winCmd";
import { runAcceptanceTool } from "../tools/runAcceptance";
import { runAcceptanceChecks, verdictKindOf } from "../live/verifier";
import { cleanupTempDirsAfterTests, tmpDir } from "./_tmp";

const WIN = process.platform === "win32";
const tmp = tmpDir("cf-win-spawn");
cleanupTempDirsAfterTests();

/** 建一个"看起来像生成出来的前端"的最小工程：frontend/package.json + build.js（零依赖） */
function mkFrontend(rel: string, o: { exitCode?: number } = {}): string {
    const dir = path.join(tmp, rel);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
        name: `fixture-${rel}`, private: true, scripts: { build: "node build.js" },
    }, null, 2), "utf-8");
    fs.writeFileSync(path.join(dir, "build.js"),
        `console.log("BUILD_OK");\nprocess.exit(${o.exitCode ?? 0});\n`, "utf-8");
    return dir;
}

/** 建项目根：proj/frontend/...（与生成项目的目录形状一致） */
function mkProject(rel: string, o: { exitCode?: number } = {}): { projectDir: string; frontend: string } {
    const projectDir = path.join(tmp, rel);
    fs.mkdirSync(projectDir, { recursive: true });
    return { projectDir, frontend: mkFrontend(path.join(rel, "frontend"), o) };
}

function softWs(projectDir: string): Workspace {
    return new Workspace({
        projectDir,
        allowedRoots: ["frontend"],
        sandbox: { mode: "soft" },
    });
}

// ============================================================
describe("winCmd：包装规则（纯函数，POSIX 行为必须零变化）", () => {
    it("POSIX：原样返回，不加任何包装", () => {
        expect(toSpawnArgv("npm", ["run", "build"], { isWin: false })).toEqual(["npm", "run", "build"]);
        expect(needsWindowsCmdForward("npm", false)).toBe(false);
        expect(needsWindowsCmdForward("mvnw.cmd", false)).toBe(false);
        expect(resolveLocalCmdShim("mvnw.cmd", tmp, false)).toBe("mvnw.cmd");
        expect(withResolvablePathKey({ Path: "X" }, false)).toEqual({ Path: "X" });
    });

    it("Windows：npm 系裸名与 .cmd/.bat 必须经 cmd.exe；普通 .exe 名不碰", () => {
        expect(needsWindowsCmdForward("npm", true)).toBe(true);
        expect(needsWindowsCmdForward("npx", true)).toBe(true);
        expect(needsWindowsCmdForward("pnpm", true)).toBe(true);
        expect(needsWindowsCmdForward("yarn", true)).toBe(true);
        expect(needsWindowsCmdForward("tsc", true)).toBe(true);
        expect(needsWindowsCmdForward("npm.cmd", true)).toBe(true);
        expect(needsWindowsCmdForward("mvnw.bat", true)).toBe(true);
        // 真的 .exe / 二进制名：绝不包装（包装了反而破坏参数与退出码语义）
        expect(needsWindowsCmdForward("node", true)).toBe(false);
        expect(needsWindowsCmdForward("git", true)).toBe(false);
        expect(needsWindowsCmdForward("cmd", true)).toBe(false);
        expect(needsWindowsCmdForward("node.exe", true)).toBe(false);
    });

    it("Windows：包装形态 = cmd.exe /d /c <命令> <参数…>（参数分列，不自己拼带引号的命令行）", () => {
        const argv = toSpawnArgv("npm", ["run", "build"], { isWin: true });
        expect(argv.length).toBe(6);                     // cmd.exe /d /c npm run build
        expect(String(argv[0]).toLowerCase()).toContain("cmd");
        expect(argv.slice(1, 4)).toEqual(["/d", "/c", "npm"]);
        expect(argv.slice(4)).toEqual(["run", "build"]);
    });

    it("Windows：命令行里的 env 必须带大写 PATH 键（Bun 传了 env 时按字面量找它）", () => {
        expect(withResolvablePathKey({ Path: "C:\\Windows", FOO: "1" }))
            .toEqual({ Path: "C:\\Windows", FOO: "1", PATH: "C:\\Windows" });
        // 已经是大写 / 没有 PATH 的：不动
        expect(withResolvablePathKey({ PATH: "Y" })).toEqual({ PATH: "Y" });
        expect(withResolvablePathKey({ FOO: "1" })).toEqual({ FOO: "1" });
        expect(withResolvablePathKey(undefined)).toBeUndefined();
    });

    it("Windows：cwd 下有同名 .cmd 才补 '.\\'（cmd 不搜当前目录），带路径的原样", () => {
        const dir = path.join(tmp, "shimdir");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "mytool.cmd"), "@echo off\r\necho LOCAL_OK\r\n", "utf-8");
        expect(resolveLocalCmdShim("mytool.cmd", dir, true)).toBe(".\\mytool.cmd");
        expect(resolveLocalCmdShim("mytool.cmd", path.join(tmp, "nope"), true)).toBe("mytool.cmd");
        expect(resolveLocalCmdShim(".\\mytool.cmd", dir, true)).toBe(".\\mytool.cmd");
        expect(resolveLocalCmdShim("C:\\x\\mytool.cmd", dir, true)).toBe("C:\\x\\mytool.cmd");
        expect(resolveLocalCmdShim("npm", dir, true)).toBe("npm");
    });
});

// ============================================================
describe("真跑：resolver 的裸 npm 经 spawn 层转发后真的构建成功（旧写法必 ENOENT）", () => {
    it("resolveProjectCommand 仍然给平台无关的逻辑命令名（跨层契约不变）", () => {
        const frontend = mkFrontend("contract-shape");
        expect(resolveProjectCommand(frontend)).toEqual({
            command: "npm", args: ["run", "build"], detectedBy: "package.json.scripts.build",
        });
    });

    it("真跑 npm run build（裸名 + 显式 env）：exit=0 且 stdout 有构建输出", async () => {
        const frontend = mkFrontend("real-ok");
        const r = resolveProjectCommand(frontend);
        expect(r).not.toBeNull();
        const argv = toSpawnArgv(r!.command, r!.args, { cwdAbs: frontend });
        // 旧写法（裸名直接给 Bun.spawn + 传 env）在这里就是 ENOENT —— 现在必须真跑起来
        const proc = Bun.spawn(argv, {
            cwd: frontend,
            stdout: "pipe",
            stderr: "pipe",
            env: withResolvablePathKey({ ...process.env } as Record<string, string>),
        });
        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout as ReadableStream).text(),
            new Response(proc.stderr as ReadableStream).text(),
        ]);
        const exitCode = await proc.exited;
        expect(stderr).not.toContain("uv_spawn");
        expect(exitCode).toBe(0);
        expect(stdout).toContain("BUILD_OK");
    }, 120_000);

    it("★ 验收判据：runAcceptance 的 COMPILE 预演能**开始并跑完**构建（实弹 ac-2 的死因）", async () => {
        const { projectDir } = mkProject("acc-pass");
        const ws = softWs(projectDir);
        const ctx = {
            workspace: ws, owner: "developerAgent", taskId: "T1",
            projectDirAbs: projectDir,
            acceptanceChecks: [{ id: "ac-2", kind: "COMPILE", target: "frontend", expected: "exitCode=0" }],
        } as never;

        const out = await runAcceptanceTool.run(ctx, { timeoutMs: 120_000 });
        const results = (out.meta as Record<string, unknown>)["results"] as Record<string, unknown>[];
        expect(results[0]?.["exitCode"]).toBe(0);
        expect(results[0]?.["timedOut"]).toBe(false);
        // 证据里保留的是逻辑命令名（平台细节不污染判据比对与日志）
        expect(results[0]?.["command"]).toBe("npm");
        expect(out.ok).toBe(true);
        expect(out.output).toContain("通过 1");
    }, 180_000);

    it("不造假绿：构建脚本失败时，退出码必须原样透出来（经 cmd.exe 也不许吞）", async () => {
        const { projectDir } = mkProject("acc-fail", { exitCode: 3 });
        const ws = softWs(projectDir);
        const ctx = {
            workspace: ws, owner: "developerAgent", taskId: "T1",
            projectDirAbs: projectDir,
            acceptanceChecks: [{ id: "ac-2", kind: "COMPILE", target: "frontend" }],
        } as never;

        const out = await runAcceptanceTool.run(ctx, { timeoutMs: 120_000 });
        const results = (out.meta as Record<string, unknown>)["results"] as Record<string, unknown>[];
        expect(results[0]?.["exitCode"]).not.toBe(0);
        expect(results[0]?.["exitCode"]).not.toBeNull();
        expect(out.ok).toBe(false);
    }, 180_000);

    it("TestAgent 通道（verifier 自带 Bun.spawn）同样能跑完 npm 构建：verdict = test_passed", async () => {
        const { projectDir } = mkProject("verifier-pass");
        const verdict = await runAcceptanceChecks(projectDir, [
            { id: "ac-2", kind: "COMPILE", target: "frontend" } as never,
        ], "acc-hash-win");
        expect(verdict.firstFailure).toBeNull();
        expect(verdict.results[0]?.exitCode).toBe(0);
        expect(verdict.results[0]?.stdout).toContain("BUILD_OK");
        expect(verdictKindOf(verdict)).toBe("test_passed");
    }, 180_000);

    it.skipIf(!WIN)("项目本地 .cmd（cmd 不搜当前目录）经 workspace.exec 也能跑起来", async () => {
        const { projectDir, frontend } = mkProject("local-shim");
        fs.writeFileSync(path.join(frontend, "mytool.cmd"), "@echo off\r\necho LOCAL_OK\r\n", "utf-8");
        const ws = softWs(projectDir);
        const r = await ws.exec("mytool.cmd", [], { cwd: "frontend", timeoutMs: 60_000 },
            { owner: "developerAgent", taskId: "T1" });
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain("LOCAL_OK");
    }, 120_000);
});
