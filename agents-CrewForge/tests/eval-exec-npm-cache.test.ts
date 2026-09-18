// ============================================================
// tests/eval-exec-npm-cache.test.ts —— 尺子自己的执行出口：npm 缓存绝不写进产物树（零 LLM）
//
//   ── 这一刀治什么（一手实证，不是推测）──
//   生成的产物里长出过整棵 npm 缓存树（不是 agent 写的代码，却混进产物盘点）：
//     · eval/baseline/runs/s4d-todo-lite/result.json ：417 条 `backend/.npm-cache/...`
//     · eval/baseline/runs/s5b-meeting-room/result.json：932 条（含 `_prebuilds/*.tar.gz`）
//   机制（本机 npm 11.6.0 实测）：`npm_config_cache=.npm-cache` 这种**相对值**会被 npm
//   按**命令 cwd** 解析 ⇒ 在 `<产物>/backend` 里 `npm install` 就长出 `<产物>/backend/.npm-cache/`。
//   相对值在本仓库没有任何代码设置过（全量 grep + 全 git 历史），所以只能由**执行出口**兜住：
//   eval/harness/exec.ts 现在把 cache 钉到产物树之外的绝对路径（%TEMP%\cf-npm-cache）。
//
//   本文件三层证据：
//     ① 纯函数：相对 / 落在 cwd 内的值 → 换成产物树外的绝对路径；合法的绝对路径原样保留；
//     ② 对照组：绕开 exec.ts 直接 spawn，同一个 `npm_config_cache=.npm-cache` 会**真的**在
//        夹具里长出 `.npm-cache`（证明机制，也证明③的断言不是空转）；
//     ③ 真命令：经 exec.ts 跑同一个 install（宿主变量仍是 `.npm-cache`）→ exit=0、
//        产出 package-lock.json，且夹具里**没有** `.npm-cache`。
// ============================================================

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { execCapture, pinNpmCacheOutOfProject, defaultNpmCacheDir } from "../eval/harness/exec";
import { cleanupTempDirsAfterTests, tmpDir } from "../developerAgent/tests/_tmp";

const WIN = process.platform === "win32";
/** 与 eval/harness/checks.ts 的 shellArgs 同形：Windows 上 .cmd 必须交 cmd.exe 执行 */
const NPM_INSTALL: { cmd: string; args: string[]; verbatimArgs?: boolean } = WIN
    ? { cmd: "cmd.exe", args: ["/d", "/s", "/c", `"npm install --no-audit --no-fund"`], verbatimArgs: true }
    : { cmd: "sh", args: ["-c", "npm install --no-audit --no-fund"] };

/** 无依赖夹具：npm 不需要联网装任何东西 */
function fixture(tag: string): string {
    const dir = tmpDir(tag);
    fs.writeFileSync(path.join(dir, "package.json"),
        JSON.stringify({ name: "cf-npmcache-proof", version: "1.0.0", private: true }, null, 2), "utf-8");
    return dir;
}

// npm 是否存在用一次真调用探明；探不明就跳过真命令那两条（诚实跳，不假装测过）
const npmProbe = await execCapture({ ...NPM_INSTALL, args: WIN ? ["/d", "/s", "/c", `"npm --version"`] : ["-c", "npm --version"], cwd: import.meta.dir, timeoutMs: 60_000 });
const NPM_OK = npmProbe.exitCode === 0;

describe("eval 执行出口 / npm 缓存不落进产物树", () => {
    test("相对值 .npm-cache → 换成产物树之外的绝对路径（其它变量一个不动）", () => {
        const r = pinNpmCacheOutOfProject({ PATH: "/usr/bin", npm_config_cache: ".npm-cache" }, path.join(os.tmpdir(), "proj", "backend"));
        expect(r.changed?.from).toBe(".npm-cache");
        expect(path.isAbsolute(r.env["npm_config_cache"]!)).toBe(true);
        expect(r.env["npm_config_cache"]).toBe(defaultNpmCacheDir());
        expect(r.env["PATH"]).toBe("/usr/bin");
    });

    test("落在命令 cwd 里的绝对路径（项目内 cache）→ 同样换成共享目录", () => {
        const cwd = path.join(os.tmpdir(), "proj", "backend");
        const inside = path.join(cwd, "npm-cache");
        const r = pinNpmCacheOutOfProject({ npm_config_cache: inside }, cwd);
        expect(r.changed?.from).toBe(inside);
        expect(r.env["npm_config_cache"]).toBe(defaultNpmCacheDir());
    });

    test("产物树之外的绝对路径 → 尊重原值，不乱改", () => {
        const outside = path.join(os.tmpdir(), "cf-host-cache");
        const r = pinNpmCacheOutOfProject({ npm_config_cache: outside }, path.join(os.tmpdir(), "proj", "backend"));
        expect(r.changed).toBeNull();
        expect(r.env["npm_config_cache"]).toBe(outside);
    });

    test("大小写两种拼写不会同时留下、互相打架", () => {
        const r = pinNpmCacheOutOfProject(
            { npm_config_cache: ".npm-cache", NPM_CONFIG_CACHE: path.join(os.tmpdir(), "other", ".npm-cache") },
            path.join(os.tmpdir(), "proj", "backend"),
        );
        expect(Object.keys(r.env).filter(k => k.toLowerCase() === "npm_config_cache")).toEqual(["npm_config_cache"]);
        expect(r.env["npm_config_cache"]).toBe(defaultNpmCacheDir());
    });

    test.skipIf(!NPM_OK)("对照组（绕开 exec.ts）：相对 cache 真的会在夹具里长出 .npm-cache", () => {
        const dir = fixture("cf-npmcache-ctl");
        const res = spawnSync(NPM_INSTALL.cmd, NPM_INSTALL.args, {
            cwd: dir,
            env: { ...process.env, npm_config_cache: ".npm-cache" },
            windowsVerbatimArguments: WIN,
            windowsHide: true,
            encoding: "utf-8",
        });
        expect(res.status).toBe(0);
        expect(fs.existsSync(path.join(dir, "package-lock.json"))).toBe(true);
        expect(fs.existsSync(path.join(dir, ".npm-cache"))).toBe(true);   // ← 缺陷本体（对照组复现）
    });

    test.skipIf(!NPM_OK)("经 exec.ts：宿主给 .npm-cache，install 成功且产物里没有缓存树", async () => {
        const dir = fixture("cf-npmcache-fix");
        const saved = process.env["npm_config_cache"];
        let r: Awaited<ReturnType<typeof execCapture>>;
        try {
            process.env["npm_config_cache"] = ".npm-cache";     // 模拟被污染的宿主环境
            r = await execCapture({ ...NPM_INSTALL, cwd: dir, timeoutMs: 300_000, label: "npm-cache-proof" });
        } finally {
            if (saved === undefined) delete process.env["npm_config_cache"];
            else process.env["npm_config_cache"] = saved;
        }
        expect(r.exitCode).toBe(0);                                        // 安装没被搞坏
        expect(fs.existsSync(path.join(dir, "package-lock.json"))).toBe(true); // 真的跑过 npm
        expect(fs.existsSync(path.join(dir, ".npm-cache"))).toBe(false);    // ★ 产物里没有缓存树
        // 缓存确实落在钉住的位置（证明 npm 用的是我们给的 cache）
        expect(fs.existsSync(path.join(defaultNpmCacheDir(), "_update-notifier-last-checked"))
            || fs.existsSync(path.join(defaultNpmCacheDir(), "_cacache"))).toBe(true);
    });
});

cleanupTempDirsAfterTests();
