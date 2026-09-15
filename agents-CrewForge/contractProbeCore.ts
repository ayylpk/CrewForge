// ============================================================
// contractProbeCore.ts —— 通用 HTTP 契约执行器（**内核**，不是 CLI）
//
//   为什么不复用 httpContractProbe.ts：那个文件是**自执行 CLI**（只有 main()，
//   零导出），只服务 hub-runner 的"翻译成命令"路线。而 r5 的教训是——
//   VERIFIER 路径（live/runner.ts）里 CONTRACT 判据被登记为 skipped，
//   模型只能自己写 selftest-*.mjs 自证（25 次自造验证 / 46 分钟）。
//
//   所以这里把"起服务 → 打请求 → 断言 → 收尸"的核**提取成可导入函数**，
//   两个调用方各取所需：
//     · httpContractProbe.ts（CLI，hub-runner 用）——薄壳，行为不变；
//     · tools/runAcceptance.ts（引擎工具，Developer 用）——直接 await。
//
//   栈无关：只认 method/path/expectedStatus/body/expectBodyContains/auth。
//   服务怎么起，全由调用方传 ServeSpec（命令 + 端口环境变量名 + 健康检查路径）。
// ============================================================

/** 怎么把被测服务跑起来 */
export interface ServeSpec {
    command: string;
    args: string[];
    /** 相对项目根的 cwd */
    cwd: string;
    /** 端口注入的环境变量名（默认 PORT） */
    portEnv?: string;
    /** 等服务的上限（默认 30s） */
    bootWaitMs?: number;
    /** 健康检查路径（默认 /） */
    healthPath?: string;
}

/**
 * 前置请求：主断言之前按序执行的请求（播数据 / 取依赖）。
 *
 *   ★ 为什么需要：真实应用的契约大多**不是孤立的一发**——
 *     "按分类筛选"要先有数据、"删除"要先有可删的对象。
 *     没有前置步骤时，这类判据只能退化成"打个 200 就算过"（弱到没有意义）。
 *
 *   两种用法：
 *     · 纯播种：{ method:"POST", path:"/api/x", body:{...}, expectedStatus:201 }；
 *     · 取变量：加 extract，把响应里的字段存进变量池，供后续步骤与主请求
 *       用 `{name}` 占位符引用（path 与 body 里都能用）。
 *
 *   ⚠️ 断言强度不变：任一前置步骤不达预期状态 → 整个检查**立即失败**并如实报现场，
 *      绝不"跳过前置照打主请求"（那会让"没播上数据"伪装成"筛选正确"）。
 */
export interface ContractSetupStep {
    method: string;
    path: string;
    body?: unknown;
    /** 期望状态码；缺省 = 2xx */
    expectedStatus?: number;
    /** 从响应里取值：{ name: "id", from: "data.id" }（点路径，相对 JSON 根） */
    extract?: { name: string; from: string };
}

/** 一条契约断言 */
export interface ContractIntent {
    method: string;
    path: string;
    expectedStatus: number;
    body?: unknown;
    expectBodyContains?: string;
    /** 登录前置：先打这个接口拿 token，再以 Bearer 发本检查 */
    auth?: { method: string; path: string; body?: unknown };
    /** 前置请求序列（按序执行；失败即整个检查失败） */
    setup?: ContractSetupStep[];
}

export interface ContractProbeResult {
    ok: boolean;
    /** 人可读的现场（进 history 给模型看） */
    output: string;
    /** 机器可读证据 */
    meta: Record<string, unknown>;
}

import fs from "node:fs";
import path from "node:path";

/** Windows 盘符路径或 POSIX 绝对路径都算绝对（本仓库在 Windows 上跑，但别写死平台） */
function isAbsolutePath(p: string): boolean {
    return path.isAbsolute(p) || /^[a-zA-Z]:[/\\]/.test(p);
}

/**
 * 杀掉**整棵进程树**（9/15 冒烟抓到的真 bug）。
 *
 *   教训现场：起服务用 `npm run dev` 时，npm 会再 fork 一个 node 子进程跑真服务。
 *   只 `proc.kill()` 只杀得掉外层 npm，**node 仍在监听端口**——服务没死，
 *   下一次探针（或用户的验收）就会撞上幽灵进程。这与 9/15 那次 TaskStop
 *   杀不干净 vite preview 是同一个坑。
 *
 *   与 tools/processManager.ts 的 killTree 同一套做法：
 *     Windows → taskkill /PID <pid> /T /F（/T = 树）；失败降级 kill(pid)；
 *     POSIX   → 先 SIGTERM 给进程组，2 秒不退再 SIGKILL。
 */
async function killTree(proc: ReturnType<typeof Bun.spawn> | null): Promise<void> {
    if (!proc || proc.exitCode !== null) return;
    const pid = proc.pid;
    if (process.platform === "win32" && typeof pid === "number" && pid > 0) {
        const r = Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], {
            stdout: "ignore", stderr: "ignore",
        });
        if (r.exitCode === 0) {
            // taskkill /F 是同步生效的，但进程状态回写要等一下
            const t = Date.now();
            while (proc.exitCode === null && Date.now() - t < 2_000) await Bun.sleep(80);
            if (proc.exitCode !== null) return;
        }
        // taskkill 不可用/失败 → 降级到单进程 kill（best-effort，如实如此）
    }
    try { proc.kill(); } catch { /* 已退 */ }
    const t = Date.now();
    while (proc.exitCode === null && Date.now() - t < 2_000) await Bun.sleep(80);
    if (proc.exitCode === null) { try { proc.kill(9); } catch { /* 已退 */ } }
}

/** 与 testAgent/verify 同一套 Windows 包装规则：npm 系与 .cmd/.bat 走 cmd /c */
export function spawnArgv(command: string, args: string[]): string[] {
    if (process.platform !== "win32") return [command, ...args];
    if (/^(npm|npx|pnpm|yarn|tsc|vite)$/i.test(command) || /\.(cmd|bat)$/i.test(command)) {
        return ["cmd", "/c", command, ...args];
    }
    return [command, ...args];
}

/** 从登录响应里取 token（token / data.token / accessToken 三种常见形状） */
export function extractToken(text: string): string | null {
    let obj: unknown;
    try { obj = JSON.parse(text); } catch { return null; }
    const o = obj as Record<string, unknown>;
    for (const cand of [o["token"], (o["data"] as Record<string, unknown> | undefined)?.["token"], o["accessToken"]]) {
        if (typeof cand === "string" && cand) return cand;
    }
    return null;
}

/**
 * 按点路径从 JSON 里取值（"data.id" / "id" / "items.0.id"）。
 * 取不到返回 undefined——调用方据此报"前置步骤没有预期的字段"，不猜测、不兜底。
 */
export function pickByPath(root: unknown, dotPath: string): unknown {
    let cur: unknown = root;
    for (const seg of dotPath.split(".")) {
        if (cur === null || cur === undefined) return undefined;
        if (Array.isArray(cur)) {
            const idx = Number(seg);
            if (!Number.isInteger(idx)) return undefined;
            cur = cur[idx];
            continue;
        }
        if (typeof cur !== "object") return undefined;
        cur = (cur as Record<string, unknown>)[seg];
    }
    return cur;
}

/** 把 "..." 里的 {name} 占位符换成变量池里的值（未定义的占位符原样保留，让它显式失败） */
export function fillVars(text: string, vars: Record<string, string>): string {
    return text.replace(/\{(\w+)\}/g, (m, name: string) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? vars[name]! : m);
}

/** 递归替换 body 里字符串中的占位符（对象/数组穿透） */
export function fillVarsDeep(value: unknown, vars: Record<string, string>): unknown {
    if (typeof value === "string") return fillVars(value, vars);
    if (Array.isArray(value)) return value.map((v) => fillVarsDeep(v, vars));
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = fillVarsDeep(v, vars);
        return out;
    }
    return value;
}

/**
 * 起服务 → 等健康 → （可选）登录取 token → 打契约请求 → 断言 → **保证收尸**。
 *
 * 端口策略与 CLI 一致：进程号派生 + 冲突换端口重试（最多 4 次）。
 * 任何路径（成功/失败/异常）都不留后台进程——finally 里 kill，2 秒不退就 kill -9。
 */
export async function runContractProbe(o: {
    projectDirAbs: string;
    serve: ServeSpec;
    intent: ContractIntent;
    /** 总超时（覆盖 boot+请求；默认 180s） */
    timeoutMs?: number;
    /** 单次请求超时（默认 15s） */
    requestTimeoutMs?: number;
    /** 日志回调（CLI 用 console.log，工具用收集器） */
    log?: (line: string) => void;
}): Promise<ContractProbeResult> {
    const say = o.log ?? ((): void => { /* 静默 */ });
    const requestTimeoutMs = o.requestTimeoutMs ?? 15_000;
    const startedAt = Date.now();
    let proc: ReturnType<typeof Bun.spawn> | null = null;
    const chunks: string[] = [];

    const deadlineAll = startedAt + (o.timeoutMs ?? 180_000);

    try {
        let bootLog = "";
        for (let tryIdx = 0; tryIdx < 4; tryIdx++) {
            if (Date.now() > deadlineAll) {
                return { ok: false, output: `契约探针总超时（${o.timeoutMs ?? 180_000}ms）`, meta: { kind: "timeout" } };
            }
            const port = 20_000 + ((process.pid * 7 + tryIdx * 419 + (Date.now() % 1000)) % 12_000);
            // serve.cwd 允许绝对路径（外部调用方常直接给绝对目录），也允许相对项目根
            const rawCwd = (o.serve.cwd ?? ".").trim() || ".";
            const cwdAbs = isAbsolutePath(rawCwd)
                ? rawCwd
                : rawCwd === "." ? o.projectDirAbs
                    : `${o.projectDirAbs.replace(/[/\\]+$/, "")}/${rawCwd.replace(/^[/\\]+/, "")}`;
            proc = Bun.spawn(spawnArgv(o.serve.command, o.serve.args), {
                cwd: cwdAbs,
                stdout: "pipe", stderr: "pipe",
                env: { ...process.env, [o.serve.portEnv ?? "PORT"]: String(port) },
            });
            const drain = (s: ReadableStream<Uint8Array> | null): void => {
                if (!s) return;
                void new Response(s).body?.pipeTo(new WritableStream({
                    write: (v: Uint8Array) => { chunks.push(new TextDecoder().decode(v)); },
                })).catch(() => { /* 进程退出，流断开 */ });
            };
            drain(proc.stdout as unknown as ReadableStream<Uint8Array>);
            drain(proc.stderr as unknown as ReadableStream<Uint8Array>);

            const bootDeadline = Math.min(deadlineAll, Date.now() + (o.serve.bootWaitMs ?? 30_000));
            let up = false;
            while (Date.now() < bootDeadline && proc.exitCode === null) {
                try {
                    await fetch(`http://127.0.0.1:${port}${o.serve.healthPath ?? "/"}`, { signal: AbortSignal.timeout(1_500) });
                    up = true; break;
                } catch { /* 还没监听，继续等 */ }
                await Bun.sleep(350);
            }
            if (up) {
                say(`probe: 服务已起 ${o.serve.command} ${o.serve.args.join(" ")} port=${port}`);
                // —— 登录前置（可选）——
                let authHeader: Record<string, string> = {};
                if (o.intent.auth) {
                    const r = await fetch(`http://127.0.0.1:${port}${o.intent.auth.path}`, {
                        method: o.intent.auth.method.toUpperCase(),
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify(o.intent.auth.body ?? {}),
                        signal: AbortSignal.timeout(requestTimeoutMs),
                    }).catch((e) => { throw new Error(`登录前置请求失败：${(e as Error).message}`); });
                    const text = await r.text();
                    if (r.status < 200 || r.status >= 300) {
                        throw new Error(`登录前置 status=${r.status}：${text.slice(0, 400)}`);
                    }
                    const token = extractToken(text);
                    if (!token) throw new Error(`登录响应没有 token 字段：${text.slice(0, 400)}`);
                    authHeader = { authorization: `Bearer ${token}` };
                    say("probe: token 已取得");
                }
                // —— 前置步骤（可选）：按序播数据 / 取变量 ——
                //   失败即整个检查失败（绝不"跳过前置照打主请求"——
                //   那会让"没播上数据"伪装成"筛选正确"）。
                const vars: Record<string, string> = {};
                const setupLogs: string[] = [];
                for (const [si, step] of (o.intent.setup ?? []).entries()) {
                    const setupInit: RequestInit = {
                        method: step.method.toUpperCase(),
                        headers: { "content-type": "application/json", ...authHeader },
                        signal: AbortSignal.timeout(requestTimeoutMs),
                    };
                    if (step.body !== undefined && !["GET", "HEAD"].includes(setupInit.method as string)) {
                        setupInit.body = JSON.stringify(fillVarsDeep(step.body, vars));
                    }
                    const setupPath = fillVars(step.path, vars);
                    const sres = await fetch(`http://127.0.0.1:${port}${setupPath}`, setupInit);
                    const sbody = await sres.text();
                    const wantOk = step.expectedStatus !== undefined
                        ? sres.status === step.expectedStatus
                        : sres.status >= 200 && sres.status < 300;
                    const line = `probe: [前置 ${si + 1}/${(o.intent.setup ?? []).length}] ${setupInit.method} ${setupPath} → ${sres.status}（期望 ${step.expectedStatus ?? "2xx"}）`;
                    say(line);
                    setupLogs.push(line);
                    if (!wantOk) {
                        return {
                            ok: false,
                            output: [...setupLogs, `正文片段 ${sbody.replace(/\s+/g, " ").slice(0, 600)}`,
                                `前置步骤失败：第 ${si + 1} 步 ${setupInit.method} ${setupPath} 返回 ${sres.status}`,
                                "（前置没成，主契约断言不执行——避免把失败伪装成通过）"].join("\n"),
                            meta: {
                                kind: "setup_failed", step: si + 1, method: setupInit.method, path: setupPath,
                                actualStatus: sres.status, expectedStatus: step.expectedStatus ?? "2xx",
                                bodyPreview: sbody.slice(0, 1000), exitCode: 1,
                            },
                        };
                    }
                    if (step.extract) {
                        let parsed: unknown;
                        try { parsed = JSON.parse(sbody); } catch { parsed = undefined; }
                        const got = pickByPath(parsed, step.extract.from);
                        if (got === undefined || got === null) {
                            return {
                                ok: false,
                                output: [...setupLogs, `正文片段 ${sbody.replace(/\s+/g, " ").slice(0, 600)}`,
                                    `前置步骤取值失败：第 ${si + 1} 步的响应里找不到 ${step.extract.from}（要存成 {${step.extract.name}}）`,
                                    "（取值没成，后续步骤的占位符无法填——主契约断言不执行）"].join("\n"),
                                meta: {
                                    kind: "setup_extract_failed", step: si + 1, from: step.extract.from,
                                    bodyPreview: sbody.slice(0, 1000), exitCode: 1,
                                },
                            };
                        }
                        vars[step.extract.name] = String(got);
                        const gotLine = `probe: [前置 ${si + 1}] 取值 {${step.extract.name}} = ${String(got).slice(0, 80)}`;
                        say(gotLine);
                        setupLogs.push(gotLine);
                    }
                }

                // —— 正式契约请求（path/body 里的 {name} 用前置取的变量填） ——
                const mainPath = fillVars(o.intent.path, vars);
                const init: RequestInit = {
                    method: o.intent.method.toUpperCase(),
                    headers: { "content-type": "application/json", ...authHeader },
                    signal: AbortSignal.timeout(requestTimeoutMs),
                };
                if (o.intent.body !== undefined && !["GET", "HEAD"].includes(init.method as string)) {
                    init.body = JSON.stringify(fillVarsDeep(o.intent.body, vars));
                }
                const res = await fetch(`http://127.0.0.1:${port}${mainPath}`, init);
                const body = await res.text();
                const head = `probe: ${init.method} ${mainPath} → ${res.status}（期望 ${o.intent.expectedStatus}），正文 ${body.length}B`;
                say(head);
                say(`probe: 正文片段 ${body.replace(/\s+/g, " ").slice(0, 300)}`);

                const meta: Record<string, unknown> = {
                    port, method: init.method, path: mainPath,
                    expectedStatus: o.intent.expectedStatus, actualStatus: res.status,
                    bodyBytes: body.length, bodyPreview: body.slice(0, 1000),
                    ...(setupLogs.length > 0 ? { setupLogs, vars: { ...vars } } : {}),
                    exitCode: (res.status === o.intent.expectedStatus ? 0 : 1),
                    durationMs: Date.now() - startedAt,
                };
                const pre = setupLogs.length > 0 ? `${setupLogs.join("\n")}\n` : "";
                if (res.status !== o.intent.expectedStatus) {
                    return {
                        ok: false,
                        output: `${pre}${head}\n正文片段 ${body.replace(/\s+/g, " ").slice(0, 600)}\n`
                            + `契约断言失败：期望 HTTP ${o.intent.expectedStatus}，实际 ${res.status}（${init.method} ${mainPath}）`,
                        meta,
                    };
                }
                if (o.intent.expectBodyContains && !body.includes(o.intent.expectBodyContains)) {
                    return {
                        ok: false,
                        output: `${pre}${head}\n正文片段 ${body.replace(/\s+/g, " ").slice(0, 600)}\n`
                            + `关键字断言失败：正文应包含「${o.intent.expectBodyContains}」`,
                        meta,
                    };
                }
                return {
                    ok: true,
                    output: `${pre}${head}\n正文片段 ${body.replace(/\s+/g, " ").slice(0, 600)}\n契约通过。`,
                    meta,
                };
            }
            // 没起来：收尸（同样要杀树：npm 拉起的子进程也得清），看是不是端口冲突
            bootLog = chunks.join("").slice(-4_000);
            await killTree(proc);
            if (!/EADDRINUSE|address already in use/i.test(bootLog)) break; // 端口冲突才换端口重试
            proc = null;
        }
        return {
            ok: false,
            output: `服务启动失败（${o.serve.command} ${o.serve.args.join(" ")} @${o.serve.cwd}）\n最后日志：\n${bootLog || "(无输出)"}`,
            meta: { kind: "boot_failed", bootLog: bootLog.slice(-2_000), exitCode: 1 },
        };
    } catch (e) {
        return {
            ok: false,
            output: (e as Error).message,
            meta: { kind: "probe_error", error: (e as Error).message, exitCode: 1 },
        };
    } finally {
        await killTree(proc);
    }
}

/**
 * 找"最可能把服务跑起来"的命令（**只读工程文件，不猜框架**）。
 *
 *   与 verifier 的 resolveProjectCommand 同思路但更宽松：契约预演需要一条
 *   **能起服务**的命令，而不只是构建命令。判定顺序：
 *     · package.json 有 dev / start 脚本 → 用包管理器的 run 形态起它；
 *     · 否则退回"构建命令"（很多最小后端 build 后可直接 node 入口——由模型自己在
 *       报告里判断这条命令到底起没起来，探针只如实报日志）。
 *
 *   ★ 找不到就**如实返回 null**，绝不编命令：模型可以自己在参数里指定 serveCommand。
 */
export function suggestServeCommand(dirAbs: string, o: { isWin?: boolean } = {}): { command: string; args: string[]; why: string } | null {
    const isWin = o.isWin ?? process.platform === "win32";
    const pkgPath = `${dirAbs.replace(/[/\\]+$/, "")}/package.json`;
    let pkg: Record<string, unknown> | null = null;
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as Record<string, unknown>; } catch { pkg = null; }
    if (pkg) {
        const scripts = (pkg["scripts"] ?? {}) as Record<string, unknown>;
        const script = typeof scripts["dev"] === "string" ? "dev"
            : typeof scripts["start"] === "string" ? "start" : null;
        if (script) {
            const runner = isWin ? "npm.cmd" : "npm";
            return { command: runner, args: ["run", script], why: `package.json.scripts.${script}` };
        }
        // 兜底：main 指向的入口（很多最小 Express 后端没有 dev/start，只有 main）
        // 只在 main 是 .js/.mjs/.cjs（node 可直接跑）时兜底；.ts 起不来，不猜。
        const main = pkg["main"];
        if (typeof main === "string" && /\.(m?js|cjs)$/i.test(main)) {
            const entry = main.replace(/^\.\//, "");
            if (fs.existsSync(`${dirAbs.replace(/[/\\]+$/, "")}/${entry}`)) {
                return { command: process.execPath, args: [entry], why: `package.json.main=${main}`, };
            }
        }
    }
    // 最后：常见入口文件（顺序**固定**，命中即用；找不到就如实返回 null）。
    //
    //   ★ 为什么"兜底探测"是安全的：探针的通过条件是**真发一次 HTTP 请求拿到期望状态码**。
    //     起服务命令猜错了 → 服务起不来 → 探针报"服务启动失败 + 启动日志"，是**诚实的失败**，
    //     而不是假通过。也就是说这里的错误只可能造成"多一次可修的报告"，
    //     **不可能**造成"没跑却说通过"——后者才是验收链路唯一的红线。
    for (const cand of ["src/index.js", "src/server.js", "index.js", "server.js", "dist/index.js"]) {
        if (fs.existsSync(`${dirAbs.replace(/[/\\]+$/, "")}/${cand}`)) {
            return { command: process.execPath, args: [cand], why: `entry-file:${cand}` };
        }
    }
    return null;
}
