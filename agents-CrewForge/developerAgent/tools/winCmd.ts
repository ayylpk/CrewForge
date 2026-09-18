// ============================================================
// tools/winCmd.ts —— Windows 上「怎么把命令真的跑起来」的**唯一**实现
//
//   ── 这一刀治什么（s4d-todo-lite / p33 实弹，本机实测复现）──
//   实弹日志：`启动失败（npm run build @ frontend）：ENOENT: no such file or
//   directory, uv_spawn 'npm'` → ac-2 永远 exit=null → Developer 无法自证 →
//   78/78 预算烧光、修复轮 0、终态 blocked。
//
//   ── 真因（本机测出来的，不是推的）──
//   F:\code\appliaction\nodejs 下只有 `npm`(无扩展名? 否) / `npm.cmd` / `npm.ps1`：
//   npm 在 Windows 上**没有**可被 CreateProcess 直接起的无扩展名可执行文件。
//
//   Bun.spawn 的两条路完全不同（`.winprobe/probe3.ts` 实测，Bun 1.3.14）：
//     · 不传 env      → spawn(["npm","--version"])                → exit=0（11.6.0）
//     · 传 env（任何形态）→ spawn(["npm"], {env: {...process.env}}) → **ENOENT**
//                       → 只有 env 里存在**大写** PATH 键时才又能跑：
//                         env.Path  → ENOENT；env.PATH → exit=0
//   本机 PATH 的键名就是 `Path`（Windows 上变量名不分大小写，cmd.exe /
//   CreateProcess / uv_os_getenv 都不分），而 Bun 在"给了 env"这条路上按字面量
//   找 `PATH`：找不到 → 裸名不做 PATHEXT 展开（`.exe` 有 CreateProcess 兜底所以
//   node/git/python/taskkill 都正常，`.cmd/.bat` 没有兜底 → ENOENT）。
//   ★ 一句话：**引擎给的 env 让 Bun 看不见 PATH，于是所有「裸名 .cmd 包装器」
//     （npm / npx / pnpm / yarn / tsc / vite…）集体起不来。**
//
//   ── 修法（两道，都在同一层：真正 spawn 的地方）──
//   ① 把命令通过 cmd.exe 转发：cmd 自己做不分大小写的 PATH 检索 + PATHEXT 展开，
//      `npm.cmd` 这类**本来就是批处理**的东西本来就该由 cmd 跑（本仓已有惯例：
//      contractProbeCore.spawnArgv / taskVerify.ts / maven.ts / eval/harness）。
//   ② 补齐 env 里的 `PATH` 键拼写（值不变），让 Bun 自己的裸名检索也恢复。
//      ①是惯例与保证，②治的是同一根因下"以后新加的裸名包装器"。
//
//   为什么放在这一层而不是解析器（projectCommands / suggestServeCommand）：
//   解析器的产物 `{ command:"npm", args:["run","build"] }` 是**跨层契约**
//   （project-commands.test.ts / architectTaskBuilder.test.ts 钉住），而且
//   `npm` 是"逻辑工具名"，`.cmd` 只是 Windows 的执行细节——把平台细节塞进
//   解析器，会让下游（证据、日志、判据比对）看到平台相关的命令名，且**绕过者**
//   （任何直接传 command:"npm" 的工具调用 / 任务包判据 / serveCommand）照样失败。
//   本文件挂在 spawn 的唯一出口上，谁都绕不过去。
// ============================================================

import fs from "node:fs";
import path from "node:path";

const IS_WIN = process.platform === "win32";

/** 批处理包装器：必须由 cmd.exe 执行（CreateProcess 不认识 .cmd/.bat） */
const CMD_SHIM_RE = /\.(cmd|bat)$/i;
/**
 * npm 系工具：Windows 上装出来的都是 .cmd/.ps1 包装器，**没有**可直接起的
 * 无扩展名可执行文件，所以裸名一定要交给 cmd 做 PATHEXT 展开。
 * 名单与 contractProbeCore.spawnArgv 保持一致（原来两份，现在共用本文件）。
 */
const NPM_FAMILY_RE = /^(npm|npx|pnpm|pnpx|yarn|yarnpkg|corepack|tsc|vite)$/i;

/** 是不是裸名（不含路径分隔符）——带路径的命令由调用方负责，不做猜测 */
function isBareName(command: string): boolean {
    return command !== "" && !command.includes("\\") && !command.includes("/");
}

/** Windows 上"必须经 cmd.exe 转发"的命令（POSIX 恒为 false） */
export function needsWindowsCmdForward(command: string, isWin: boolean = IS_WIN): boolean {
    if (!isWin) return false;
    if (CMD_SHIM_RE.test(command)) return true;
    return isBareName(command) && NPM_FAMILY_RE.test(command);
}

/**
 * Windows 的 `.\` 前缀规则。
 * 9/12 mysite T1 实弹坑：cmd 不搜当前目录（裸 mvnw.cmd → "不是内部或外部命令"），
 * runBuild 因此永远假失败。修法：命令没带路径分隔符、且 cwd 下确有同名文件时补 ".\"。
 */
export function resolveLocalCmdShim(command: string, cwdAbs: string, isWin: boolean = IS_WIN): string {
    if (!isWin) return command;
    if (!/\.(cmd|bat|exe)$/i.test(command)) return command;
    if (command.includes("\\") || command.includes("/")) return command;
    try {
        if (fs.existsSync(path.join(cwdAbs, command))) return `.\\${command}`;
    } catch {
        // cwd 不存在 → 原样返回，让 spawn 报出真实的启动错误
    }
    return command;
}

/** cmd.exe 的绝对路径（ComSpec 优先；拿不到就退回裸名，Windows 会用系统默认） */
function comspec(): string {
    return process.env["ComSpec"] ?? process.env["COMSPEC"] ?? "cmd.exe";
}

/**
 * 真正交给 Bun.spawn 的 argv。
 *
 *   · POSIX 原样返回（本文件对 Unix 行为零影响）；
 *   · Windows 上 .cmd/.bat 与 npm 系裸名 → `cmd.exe /d /c <命令> <参数…>`。
 *     参数**分列**传（不自己拼一条带引号的命令行）：运行时会按 Windows 规则
 *     给带空格的参数加引号，而 `\"` 这种转义 cmd.exe 不认识——
 *     envProbe.ts:378 已经把这个坑记在案（分列实测可用）。
 *     `/d` 跳 AutoRun，`/c` 跑完即退（不留常驻 shell）。
 */
export function toSpawnArgv(
    command: string,
    args: readonly string[],
    o: { cwdAbs?: string; isWin?: boolean } = {},
): string[] {
    const isWin = o.isWin ?? IS_WIN;
    if (!isWin) return [command, ...args];
    const resolved = o.cwdAbs === undefined ? command : resolveLocalCmdShim(command, o.cwdAbs, isWin);
    if (!needsWindowsCmdForward(resolved, isWin)) return [command, ...args];
    return [comspec(), "/d", "/c", resolved, ...args];
}

/**
 * Windows 上把 env 里的 `Path` 补成 `PATH`（值不变）。
 *
 *   为什么不能只靠 cmd 转发：cmd 只覆盖"经它跑的命令"；引擎自己还会用
 *   Bun.spawn 直接起别的裸名包装器。Bun 在传了 env 时按**字面量** `PATH`
 *   找可执行文件（实测：env.Path → ENOENT，env.PATH → exit=0），
 *   而 Windows 的惯例拼写是 `Path`——于是所有裸名 .cmd 一起消失。
 *   Windows 的变量名本来就不分大小写，补一个大写键对子进程语义零改变
 *   （实测 cmd.exe 在新旧两种拼写下看到的 PATH 完全相同）。
 */
export function withResolvablePathKey(
    env: Record<string, string> | undefined,
    isWin: boolean = IS_WIN,
): Record<string, string> | undefined {
    if (!isWin || env === undefined) return env;
    if (env["PATH"] !== undefined) return env;
    const key = Object.keys(env).find((k) => k.toLowerCase() === "path");
    if (key === undefined) return env;
    const value = env[key];
    if (value === undefined) return env;
    return { ...env, PATH: value };
}
