// ============================================================
// renderGate.ts —— T6 渲染审（9/8）：headless Edge 真渲染，测试工位的"眼睛"
//
//   治什么病（F7）：纸审只读代码不看运行结果——白屏/运行时炸全盲。
//   F6 已实测 headless Edge 可用（--dump-dom 能执行 JS 抓到渲染后 DOM），零新依赖。
//
//   组成：
//     ensureServer   runs/pN/frontend 起 vite dev（惰性/复用/每进程一次），缺 node_modules 先 bun install
//     dumpDom        msedge --headless --virtual-time-budget=8000 --dump-dom → 渲染后 HTML
//     screenshot     同引擎 --screenshot 存 runs/pN/_shots/（看板回显素材，阶段 6 消费）
//     judgeDom       纯函数判白屏——**规则搬去了 visibleText.ts**（9/18 修正，见下），
//                    这里只做适配：老调用方（render-smoke.ts）继续用同一个出口，签名不变。
//   旁路原则：装不上依赖/起不了服/找不到 Edge/任何异常 → {status:"skip", reason}——
//   渲染审是证据层不是控制层；skip 也要出现在测试报告里（不静默降级）。
//   清理：closeRenderGates() 挂 runner 出口（同 closeTdesignMcp/closeTaskBridge 姿势），
//   Windows 下 vite→esbuild 孙进程链用 taskkill /T 整树杀，防孤儿占端口。
//
//   ★ 9/18 修正的缺陷（"眼睛"刻度错了）：老 judgeDom 的可见文本是"去掉标签剩下的字"，
//     于是 **<head> 里的 <title> 也被算成了可见文本**——白屏页只要标题够长就能蒙混过关。
//     实测（真 headless Edge 跑出来的白屏页：壳 + <title> 32 字 + 空 <div id="app"></div> + bundle 已执行）：
//         旧口径 textLen=54 / elCount=15 / blank=false（判成"有内容"）
//         新口径 textLen=0  / elCount=13 / blank=true
//     eval 侧早就在这份文件上留了路标（eval/harness/checks.ts:477 明说"不重复那个错"），
//     所以判定规则收敛到 visibleText.ts 一处实现：body 优先取文本、排除 head/title/script/
//     style/noscript/template/注释、认「SPA 挂载点为空」，并保留老的最小文本/元素数阈值。
//     证据形状（elCount/textLen/title/url/shot/reason）保持原样，下游与冒烟脚本不受影响。
// ============================================================

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { projectDir } from "./runEnv";
import { extractTitle, judgeVisibleDom } from "./visibleText";

export interface RenderOutcome {
    status: "pass" | "fail" | "skip";
    blank?: boolean;
    elCount?: number;
    textLen?: number;
    title?: string | null;
    /** 空挂载点（#app/#root/#main 里什么都没有）——诊断用，附加字段，下游可忽略 */
    mountEmpty?: boolean;
    mountId?: string | null;
    url?: string;
    shot?: string | null;
    reason?: string;
}

// ---------- Edge 定位 ----------

let edgeExe: string | null | undefined;
function findMsEdge(): string | null {
    if (edgeExe !== undefined) return edgeExe;
    const roots = [process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", process.env.ProgramFiles ?? "C:\\Program Files"];
    edgeExe = null;
    for (const r of roots) {
        const p = path.join(r, "Microsoft", "Edge", "Application", "msedge.exe");
        if (fs.existsSync(p)) { edgeExe = p; break; }
    }
    return edgeExe;
}

// ---------- DOM 判定（纯函数，狗考入口；规则本体在 visibleText.ts） ----------

export interface DomVerdict {
    blank: boolean;
    elCount: number;
    textLen: number;
    title: string | null;
    /** 附加诊断（老调用方不读也无妨）：命中/未命中的 SPA 挂载点 */
    mountId?: string | null;
    mountEmpty?: boolean;
    /** 判白屏的理由（blank=true 时点名踩了哪条） */
    blankReason?: string | null;
}

/**
 * 判渲染后 DOM 是否白屏。**textLen 只数人眼能看见的字**：head/title/script/style/noscript/
 * template/注释一律不算（老实现把 <title> 算进去了，白屏页只要标题够长就能过关——9/18 修）。
 * 白屏 = 可见文本 < 24 字 **或** SPA 挂载点（#app/#root/#main）是空的 **或** 元素数 < 12。
 * title 仍作为证据返回（报告里看得见），但**不参与**判定：标题不是渲染出来的内容。
 */
export function judgeDom(html: string): DomVerdict {
    const v = judgeVisibleDom(html);
    return {
        blank: v.blank, elCount: v.elCount, textLen: v.textLen, title: extractTitle(html),
        mountId: v.mount?.id ?? null, mountEmpty: v.mount?.empty ?? false, blankReason: v.reason,
    };
}

// ---------- vite dev server 生命周期（每项目一实例，进程内复用） ----------

interface ServerHandle { port: number; child: ChildProcess; label: string }
const servers = new Map<number, Promise<ServerHandle | null>>();
const logs = new Map<number, string>();   // 启动失败时的尾部日志（skip reason 用）

function frontendRoot(pid: number): string { return path.join(projectDir(pid), "frontend"); }

async function startServer(pid: number): Promise<ServerHandle | null> {
    const dir = frontendRoot(pid);
    if (!fs.existsSync(path.join(dir, "index.html")) && !fs.existsSync(path.join(dir, "package.json"))) {
        logs.set(pid, "frontend 目录不存在（无 UI 项目/未落地）"); return null;
    }
    // 依赖没装先补一次 bun install（npmmirror 源；600s 上限）——装不上=skip 有理由，不静默
    if (!fs.existsSync(path.join(dir, "node_modules"))) {
        try {
            execFileSync("bun", ["install", "--registry=https://registry.npmmirror.com"], { cwd: dir, timeout: 600_000, stdio: "ignore", windowsHide: true });
        } catch (e) {
            logs.set(pid, `bun install 失败：${(e as Error).message.slice(0, 120)}`); return null;
        }
    }
    const port = 5100 + (pid % 80);
    // Windows npx 是 .cmd，不经 shell 起不来（9/5 stdio 同款坑）→ cmd /c 包一层
    const child = spawn("cmd", ["/c", "npx", "vite", "--port", String(port), "--strictPort"],
        { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    child.stdout?.on("data", d => { tail = (tail + d.toString()).slice(-4000); });
    child.stderr?.on("data", d => { tail = (tail + d.toString()).slice(-4000); });
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
        if (child.exitCode != null) { logs.set(pid, `vite 提前退出(${child.exitCode})：${tail.slice(-200)}`); return null; }
        try {
            const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
            if (res.status < 500) { child.on("exit", () => servers.delete(pid)); return { port, child, label: `p${pid}@${port}` }; }
        } catch { /* 还没就绪，半秒后再探 */ }
        await new Promise(r => setTimeout(r, 500));
    }
    child.kill(); logs.set(pid, `vite 90s 未就绪：${tail.slice(-200)}`);
    return null;
}

/** 拿（或懒起）本项目的 dev server；null=起不动（skip 路径，理由在 lastSkipReason） */
function ensureServer(pid: number): Promise<ServerHandle | null> {
    let p = servers.get(pid);
    if (!p) { p = startServer(pid); servers.set(pid, p); }
    return p;
}

export function lastServerSkipReason(pid: number): string { return logs.get(pid) ?? "dev server 不可用"; }

/** runner 出口挂钩（await 版，防 process.exit 抢跑杀不掉）：整树杀 vite 进程链（cmd→node→esbuild），绝不留孤儿 */
export async function closeRenderGates(): Promise<void> {
    for (const [, p] of servers) {
        const h = await p.catch(() => null);
        if (!h) continue;
        try { execFileSync("taskkill", ["/pid", String(h.child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); }
        catch { try { h.child.kill(); } catch { /* 已经死了 */ } }
    }
    servers.clear();
}

// ---------- edge 调用 ----------
//
// ⚠️ 两条硬要求（9/18 与 eval/harness/checks.ts:462-465 对齐）：
//   ① --headless=new + --no-sandbox 必须原样带上；**任何情况下都不许去掉 headless**——
//      非 headless 的 msedge 会在用户桌面上真的弹出浏览器窗口（今晚已被咬过一次）。
//   ② --user-data-dir 必须指到本次调用专属的临时目录：不给的话，机器上已经开着一个 Edge 时
//      headless 调用会**移交给那个实例**（拿到空 dump / 配置文件被占），于是"眼睛"静默变成 skip。
//      收尾把 profile 删掉，绝不留垃圾（删不掉也只是 %TEMP% 里一个目录，不抛）。

let edgeProfileSeq = 0;

/** 组装一次 headless Edge 调用的参数（纯函数，可单测）：headless 是第一颗钉子 */
export function buildEdgeArgs(profileDir: string, args: readonly string[]): string[] {
    return ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", `--user-data-dir=${profileDir}`, ...args];
}

function runEdge(args: string[], timeoutMs = 60_000): { ok: boolean; out: string } {
    const exe = findMsEdge();
    if (!exe) return { ok: false, out: "msedge 未找到" };
    const profileDir = path.join(os.tmpdir(), `cf-rendergate-edge-${process.pid}-${edgeProfileSeq++}`);
    try {
        const out = execFileSync(exe, buildEdgeArgs(profileDir, args),
            { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: "utf-8" });
        return { ok: true, out: out ?? "" };
    } catch (e) {
        return { ok: false, out: (e as Error).message.slice(0, 200) };
    } finally {
        try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 }); }
        catch { /* Edge 还在收尾（profile 文件被占）：留给系统清理，不因为垃圾目录把渲染审搞挂 */ }
    }
}

/**
 * 对本项目前端做一次渲染审：dump-dom 判白屏 + 截图存档 _shots/。
 * 一切异常（edge 缺失/超时/起服失败）=skip 带理由——证据层不拦路，但理由必须可见。
 */
export async function renderCheckFrontend(pid: number, label: string): Promise<RenderOutcome> {
    try {
        const server = await ensureServer(pid);
        if (!server) return { status: "skip", reason: lastServerSkipReason(pid) };
        const url = `http://127.0.0.1:${server.port}/`;
        const dumped = runEdge(["--virtual-time-budget=8000", "--dump-dom", url]);
        if (!dumped.ok) return { status: "skip", url, reason: `dump-dom 失败：${dumped.out}` };
        const v = judgeDom(dumped.out);
        // 截图尽力而为（失败不影响判定；_shots/ 在产物树内、runs 之外不污染 git——runs 整目录本就被 ignore）
        let shot: string | null = null;
        try {
            const shotsDir = path.join(projectDir(pid), "_shots");
            fs.mkdirSync(shotsDir, { recursive: true });
            shot = path.join(shotsDir, `${label}.png`);
            const snap = runEdge(["--window-size=1280,900", `--virtual-time-budget=8000`, `--screenshot=${shot}`, url]);
            if (!snap.ok || !fs.existsSync(shot)) shot = null;
        } catch { shot = null; }
        return {
            status: v.blank ? "fail" : "pass", blank: v.blank,
            elCount: v.elCount, textLen: v.textLen, title: v.title, url, shot,
            mountId: v.mountId ?? null, mountEmpty: v.mountEmpty ?? false,
            // 白屏理由点名踩了哪条（可见文本少 / 挂载点为空 / 元素太少）：REPAIR 提示要指对方向
            reason: v.blank
                ? `渲染白屏：${v.blankReason ?? `可见文本 ${v.textLen} 字`}（DOM 元素 ${v.elCount} 个；标题「${v.title ?? "无"}」不算文本）`
                : `渲染非空：${v.elCount} 元素/${v.textLen} 字/标题=${v.title ?? "无"}`,
        };
    } catch (e) {
        return { status: "skip", reason: `渲染审异常：${(e as Error).message.slice(0, 160)}` };
    }
}
