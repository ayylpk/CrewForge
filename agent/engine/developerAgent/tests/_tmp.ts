// ============================================================
// developerAgent/tests/_tmp.ts —— 测试临时目录的统一创建与清理（零 LLM）
//
//   任何测试文件都能 import（Hub 侧的 tests/** 走 `../developerAgent/tests/_tmp`，
//   见文件末的「跨根引用」说明）—— 单点实现，避免两份行为不一致的拷贝。
//
//   为什么要有这个文件（9/17 本机实测，不是猜的）：
//     `bun test developerAgent/tests/` 跑一遍，%TEMP% 里会多出 7 个目录：
//       cf-dev-cmd- / cf-dev-sandbox- / cf-dev-soft- / cf-dev-timeout- /
//       cf-llm-review- / cf-accept-surface- / cforge-accept-
//     （实测：一次运行 11 个目录 / 8.5 MB，其中 7 个是一文件一个；攒久了就是
//      911 个目录 / 668.6 MB）。根因两条，两条都在这里正面解决：
//
//     ① 这些文件**刻意不删树**。老注释写得很清楚（sandbox.test.ts:37）：
//        「Windows 上删树要 6 秒以上，会把 afterAll 的 5 秒 hook 超时打爆（实测过）」。
//        → 这里给 afterAll 显式传超时。bun 的 HookOptions 就是 `number | {timeout}`
//          （bun-types/test.d.ts:308），实测一个 7 秒的钩子传 20_000 不会被默认 5 秒掐掉。
//
//     ② 就算删，也常常删不掉：Windows 上文件被子进程 / sqlite(WAL) 占着时 rmSync 直接
//        抛 EBUSY。实测（bun 1.3.14）：
//            RM-OPEN-DB: FAILED EBUSY: resource busy or locked, rm 'C:\...\cf-lockprobe-XXXX'
//            RM-AFTER-CLOSE: ok removed=true
//        —— 同一个目录，db.close() 之后同一条 rmSync 立刻成功。
//        原来的写法是 `catch { /* ignore */ }`：**静默吞掉**，于是这个缺陷藏了几个星期。
//        → 重试 + 退避；最终仍失败就**大声报出来**（点名目录 + 错误 + 手工删除命令），
//          绝不吞。
//
//   ⚠️ 钩子为什么挂在「文件」上，而不是「进程」上（同样是实测结论）：
//     · bun test **不执行** process.on("exit") / beforeExit —— 在这两个 handler 里写标记
//       文件、删目录，整个 suite 跑完标记文件根本没生成、临时目录原样留着（bun 1.3.14）。
//       所以「用 process.on('exit') 兜底」在本运行时的测试里是不存在的，只能靠钩子。
//     · afterAll 的作用域是**文件级**：同一个模块被多个测试文件 import 时模块体只跑一次
//       （模块缓存），里面注册的 afterAll 会落在**第一个** import 它的文件作用域里，
//       在那个文件收尾时就跑了 —— 对后面那些文件留下的目录毫无帮助（实测：两个测试文件
//        import 同一个模块，模块里的 afterAll 只跑了一次，且早于第二个文件的用例）。
//     · 同一文件内 afterAll 按**注册顺序**执行（实测）。而「先关账本、再删树」是硬要求
//       （开着 sqlite 删树必 EBUSY，见上），所以清理钩子必须注册在文件自己的 afterAll
//       **之后**：
//
//           afterAll(() => { for (const l of opened) { try { l.close(); } catch {} } });
//           cleanupTempDirsAfterTests();      // ← 必须在上面这行之后
//
//     → 结论：每个用到临时目录的文件注册**一个**自己的清理钩子（同一文件重复调用只挂一次，
//       靠调用栈认身份），整个进程不会重复挂、也不会漏挂。
//
//   跨根引用：Hub 侧的测试（agents-CrewForge/tests/**）直接
//   `import { tmpDir } from "../developerAgent/tests/_tmp";`。不做第二份拷贝的原因：
//   这份逻辑的难点全在「bun 的钩子语义」上（文件级作用域 / 注册顺序 / 没有 exit 钩子），
//   两份拷贝迟早会跑偏；一个共享文件 + 相对路径 import 在 tsc 与 bun test 下都能过。
// ============================================================

import { afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 本次运行专属根目录：cf-testrun-<pid>。一次运行只留一个目录，残留了也一眼认得出是谁的。 */
const RUN_ROOT = path.join(os.tmpdir(), `cf-testrun-${process.pid}`);

/** 已登记、还没确认删掉的目录（删成功的会摘掉，所以重复清理是幂等的） */
const pending = new Set<string>();

/** afterAll 的钩子超时：删树要好几秒，用默认 5 秒会把收尾变成「钩子超时」错误 */
const CLEANUP_HOOK_TIMEOUT_MS = 60_000;

/** 重试次数与退避步长：Windows 的占用基本是瞬时的（子进程刚死 / WAL 刚合并） */
const MAX_ATTEMPTS = 4;
const BACKOFF_MS = 75;

/** 陈旧运行根的清理阈值：超过这个时间且进程已不在，才认定是上次崩溃留下的 */
const STALE_RUN_MS = 30 * 60 * 1000;

let seq = 0;

export interface TempCleanupReport {
    removed: string[];
    failed: { dir: string; error: string }[];
}

/** 同步睡 —— afterAll 里没有 await 的机会，退避只能同步睡（bun 支持 Atomics.wait） */
function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 本次运行的根目录（所有 tmpDir 都在它下面）；顺手登记，免得留个空壳目录 */
export function tmpRunRoot(): string {
    fs.mkdirSync(RUN_ROOT, { recursive: true });
    pending.add(RUN_ROOT);
    return RUN_ROOT;
}

/**
 * 建一个本次运行的临时目录并登记清理。等价于原来的
 * `fs.mkdtempSync(path.join(os.tmpdir(), "<prefix>-"))`，只是换成运行根下的子目录：
 * 目录名仍保留原来的 tag（cf-dev-sandbox- 之类），排查时照样一眼认得。
 */
export function tmpDir(tag: string): string {
    pruneStaleRuns();
    const safe = tag.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "tmp";
    const dir = path.join(tmpRunRoot(), `${safe}-${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(dir, { recursive: true });
    pending.add(dir);
    return dir;
}

/** 删一棵树：Node 自带的 maxRetries/retryDelay 先顶一轮 EBUSY/EPERM，外面再退避重试 */
function removeTree(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

/**
 * 清掉所有登记过的临时目录。同步、幂等、可反复调用（afterAll 与手工核查都走它）。
 * 长的路径先删（子目录），短的（运行根）最后删。
 */
export function cleanupTempDirs(o: { attempts?: number; backoffMs?: number } = {}): TempCleanupReport {
    const attempts = o.attempts ?? MAX_ATTEMPTS;
    const backoffMs = o.backoffMs ?? BACKOFF_MS;
    const removed: string[] = [];
    const failed: TempCleanupReport["failed"] = [];
    for (const dir of [...pending].sort((a, b) => b.length - a.length)) {
        let lastError: string | null = null;
        for (let i = 0; i < attempts && fs.existsSync(dir); i++) {
            try {
                removeTree(dir);
                lastError = null;
            } catch (e) {
                lastError = e instanceof Error ? e.message : String(e);
                sleepSync(backoffMs * (i + 1));
            }
        }
        if (!fs.existsSync(dir)) {
            pending.delete(dir);
            removed.push(dir);
        } else {
            failed.push({ dir, error: lastError ?? "目录仍在（rmSync 没抛错但没删掉）" });
        }
    }
    return { removed, failed };
}

/** 已经报过的目录：同一个目录在一次运行里只喊一次（否则 40 个文件会各喊一遍，反而没人看） */
const reported = new Set<string>();

/**
 * 删不掉就大声说：点名目录、原因、手工删除命令。
 * 「静默吞掉」正是这个缺陷藏了几星期的原因，所以这里绝不 catch 了事。
 */
export function reportTempCleanupProblems(report: TempCleanupReport, phase: string): void {
    const fresh = report.failed.filter((f) => !reported.has(f.dir));
    if (fresh.length === 0) return;
    for (const f of fresh) {
        reported.add(f.dir);
        console.error(`[tmp-cleanup] ❌ 临时目录删不掉（${phase}）：${f.dir}`);
        console.error(`[tmp-cleanup]    原因：${f.error}`);
        console.error(`[tmp-cleanup]    手工删除：Remove-Item -LiteralPath '${f.dir}' -Recurse -Force`);
    }
    console.error(`[tmp-cleanup] ⚠️ 本次运行残留 ${report.failed.length} 个临时目录（上面逐条点名，同一个目录只报一次）；测试结果不受影响，但请修掉占用或手工清理。`);
}

/** 认调用方文件（钩子是文件级的，同一个文件只挂一次；认不出就照挂，宁可多挂不可漏挂） */
function callerFileOf(): string | null {
    const self = path.resolve(import.meta.path);
    for (const line of new Error().stack?.split("\n") ?? []) {
        const m = /((?:file:\/\/\/)?[A-Za-z]:[\\/][^()\s]+\.(?:ts|tsx|js|mjs))(?::\d+:\d+)?/.exec(line);
        const file = m?.[1];
        if (file === undefined) continue;
        const abs = path.resolve(file.replace(/^file:\/\/\//, ""));
        if (abs === self) continue;
        return abs;
    }
    return null;
}

const hookedFiles = new Set<string>();

/**
 * 注册本文件的收尾清理钩子。**必须写在文件自己的 afterAll 之后**（见文件头的实测说明：
 * 钩子按注册顺序跑，顺序反了就会在账本还开着的时候删树，Windows 上必 EBUSY）。
 */
export function cleanupTempDirsAfterTests(): void {
    const caller = callerFileOf();
    if (caller !== null && hookedFiles.has(caller)) return;
    if (caller !== null) hookedFiles.add(caller);
    afterAll(() => {
        reportTempCleanupProblems(cleanupTempDirs(), "afterAll");
    }, { timeout: CLEANUP_HOOK_TIMEOUT_MS });
}

/**
 * 顺手清掉**上次崩溃**留下的运行根（cf-testrun-<pid>）：进程已不在且超过 30 分钟才算陈旧，
 * 所以正在并发跑测试的进程不会被误删。每个进程只做一次。
 */
let pruned = false;
function pruneStaleRuns(): void {
    if (pruned) return;
    pruned = true;
    let entries: string[];
    try {
        entries = fs.readdirSync(os.tmpdir());
    } catch {
        return;
    }
    for (const name of entries) {
        const m = /^cf-testrun-(\d+)$/.exec(name);
        const pid = m?.[1];
        if (pid === undefined || Number(pid) === process.pid) continue;
        const dir = path.join(os.tmpdir(), name);
        // ① 进程还在（或权限说不清）→ 不动它：并发跑测试的进程不能被误删
        let alive = true;
        try {
            process.kill(Number(pid), 0);
        } catch (e) {
            alive = (e as { code?: string }).code === "EPERM";
        }
        if (alive) continue;
        // ② 目录还在且太新 → 也不动（双保险：pid 被复用 / kill 语义与本机不符的情况）
        let stale = true;
        try {
            stale = Date.now() - fs.statSync(dir).mtimeMs >= STALE_RUN_MS;
        } catch {
            stale = false;   // 目录已经不在了，没什么可清
        }
        if (!stale) continue;
        try {
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {
            /* 陈旧目录清不掉就算了，不打扰本次测试 */
        }
    }
}
