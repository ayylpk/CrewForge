// ============================================================
// developerAgent/tests/render-gate.test.ts —— 渲染审的"眼睛"刻度（零 LLM，一次真 headless Edge）
//
//   为什么有这个文件（9/18，实测不是推理）：
//     老 renderGate.judgeDom 算"可见文本"用的是「去掉标签剩下的就是文本」，
//     于是 **<head> 里的 <title> 也被当成了渲染出来的字**。一份白屏页（#app 空、bundle 照样
//     加载执行）只要标题够长，就能把 textLen 顶过 24 字阈值，被判"有内容"：
//         旧口径（真 headless Edge 跑出来的白屏页）：textLen=54（标题 32 字 + noscript 22 字）
//                 elCount=15 ≥ 12 → blank=false（白屏蒙混过关）
//         新口径同一份 DOM：textLen=0 elCount=13 blank=true（挂载点 #app 为空）
//     另：今天真实跑挂的 s4d-todo-lite 页面，旧口径 textLen=12 而 body 里一个字没有——
//     那 12 个字**全部来自 <title>CrewForge 应用</title>**。那一页当时靠"元素 8<12 且 12<24"
//     两条兜底仍然判了白屏，所以这个坑是**潜伏**的（标题再长一点就翻）。
//     eval/harness/checks.ts:477 早就点名过这个坑（"这里不重复那个错"），但那份文件
//     禁止改动，所以判定规则收敛到 visibleText.ts 一处实现，本文件钉住它：
//       · 只数人眼能看见的字（head/title/script/style/noscript/template/注释/零宽字符都不算）
//       · 空 SPA 挂载点（#app/#root/#main）= 白屏（壳在、组件没挂上）
//       · 正文最小字数与最小元素数阈值
//
//   分层（慢的东西只跑一次）：
//     A. 纯函数用例：DOM 字符串判白屏，不起服不拉浏览器（绝大多数坑在这里）
//     B. 集成用例（**一条**）：真起 Bun 静态服 + 真跑 headless Edge dump-dom，
//        两个 fixture（白屏 / 有内容）各判一次。
//
//   ⚠️ Edge 安全铁律（今晚被咬过：一条 msedge --version 就在桌面上弹了真窗口）：
//       永远 --headless=new（buildEdgeArgs 的第一颗钉子，另有单测钉住），
//       并给每次调用专属 --user-data-dir（机器上已开着的 Edge 会截胡非独立 profile 的调用），
//       profile 建在本文件登记的临时目录里 → 随 _tmp.ts 收尾清理；不整机 kill msedge
//       （那会顺手杀掉用户自己的浏览器窗口）。
// ============================================================

import { describe, expect, it, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { buildEdgeArgs, judgeDom } from "../../renderGate";
import {
    MIN_ELEMENTS, MIN_VISIBLE_TEXT, countElements, detectMount, extractTitle, extractVisibleText, judgeVisibleDom,
} from "../../visibleText";
import { cleanupTempDirsAfterTests, tmpDir } from "./_tmp";

// ============================================================
// A. 纯函数：判白屏 / 抽可见文本 / 认挂载点
// ============================================================

/** 长标题：老口径就是靠它把"可见文本"顶过 24 字阈值的（本文件第一组用例的靶子） */
const TITLE_TEXT = "CrewForge 待办清单应用 —— 任务管理系统（演示环境）";

interface ShellOpts { title?: string; noscript?: boolean; scriptSrc?: string }

/** 一份「构建产物」形态的壳：head 里 meta/link/script 齐全 → 元素数过 12，老口径的元素数兜底也拦不住 */
function shellHtml(bodyInner: string, opts: ShellOpts = {}): string {
    const title = opts.title ?? TITLE_TEXT;
    const scriptSrc = opts.scriptSrc ?? "/assets/index.js";
    return `<!DOCTYPE html><html lang="zh-CN"><head>`
        + `<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">`
        + `<meta name="theme-color" content="#0052d9"><meta name="description" content="待办清单">`
        + `<title>${title}</title>`
        + `<script type="module" crossorigin src="${scriptSrc}"></script>`
        + `<link rel="stylesheet" crossorigin href="/assets/index.css">`
        + `<link rel="modulepreload" crossorigin href="/assets/vendor.js">`
        + `<link rel="modulepreload" crossorigin href="${scriptSrc}">`
        + `<link rel="icon" href="/favicon.ico">`
        + `</head><body>`
        + (opts.noscript === true ? `<noscript><p>请启用 JavaScript 后使用本应用</p></noscript>` : "")
        + bodyInner
        + `</body></html>`;
}

/** 白屏页的 DOM 形态：壳齐全、bundle 已加载（data-bundle 标记），但 #app 里一个字都没有 */
const BLANK_DOM = shellHtml(`<div id="app" data-bundle="loaded"></div>`);

/** 有内容页的 DOM 形态：同一个壳，JS 真把待办清单渲染进了 #app */
const CONTENT_DOM = shellHtml(
    `<div id="app"><header><h1>待办清单</h1></header>`
    + `<form><input placeholder="新任务"><button>添加</button></form>`
    + `<ul><li>买牛奶</li><li>写代码</li><li>读书</li><li>跑步</li></ul>`
    + `<footer><p>共 4 项待办</p></footer></div>`,
);

/** 渲染进 #app 的那段真 UI（集成用例里由 main.js 照抄执行，两处必须一致） */
const APP_INNER_HTML =
    `<header><h1>待办清单</h1></header>`
    + `<form><input placeholder="新任务"><button>添加</button></form>`
    + `<ul><li>买牛奶</li><li>写代码</li><li>读书</li><li>跑步</li></ul>`
    + `<footer><p>共 4 项待办</p></footer>`;

/**
 * 旧 renderGate.judgeDom（9/18 修正前的原样拷贝），**只用来钉住"老口径会放过白屏"**。
 * ⚠️ 这不是生产代码，任何地方都不要用它判白屏——它存在的唯一目的是：
 * 一旦有人把可见文本口径改回「去标签即文本」，下面第一组用例立刻红。
 */
function legacyJudgeDom(html: string): { blank: boolean; elCount: number; textLen: number } {
    const stripped = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ");
    const elCount = (stripped.match(/<[a-zA-Z][^>]*>/g) ?? []).length;
    const textLen = stripped.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length;
    return { blank: elCount < 12 || textLen < 24, elCount, textLen };
}

describe("渲染审判白屏：只有标题的页面 = 白屏（老坑的正面钉死）", () => {
    it("★ 老口径会把这一页判成「有内容」——这就是修的坑", () => {
        const legacy = legacyJudgeDom(BLANK_DOM);
        expect(legacy.blank).toBe(false);                             // 老口径放行（白屏蒙混过关）
        expect(legacy.textLen).toBe(TITLE_TEXT.length);               // 那 30 多个"字"全部来自 <title>
        expect(legacy.elCount).toBeGreaterThanOrEqual(MIN_ELEMENTS);  // 元素数兜底也没拦住
    });

    it("★ 新口径同页判白屏，textLen=0（标题一个字都不算）", () => {
        const v = judgeVisibleDom(BLANK_DOM);
        expect(v.textLen).toBe(0);
        expect(v.blank).toBe(true);
        expect(v.reason).toContain("可见文本 0 字");
    });

    it("整篇只有 <title>（连壳都没有）→ 白屏", () => {
        const v = judgeVisibleDom(`<html><head><title>${TITLE_TEXT}</title></head><body></body></html>`);
        expect(v.textLen).toBe(0);
        expect(v.blank).toBe(true);
    });

    it("judgeDom（renderGate 出口）与纯函数同判：白屏 true / 标题仍作证据返回", () => {
        const v = judgeDom(BLANK_DOM);
        expect(v.blank).toBe(true);
        expect(v.textLen).toBe(0);
        expect(v.title).toBe(TITLE_TEXT);        // 标题照样抓出来给人看，但不参与判定
        expect(v.mountEmpty).toBe(true);
        expect(v.mountId).toBe("app");
        expect(v.blankReason).toContain("挂载点");
    });
});

describe("渲染审判白屏：空挂载点（壳在、bundle 在、组件没挂上）", () => {
    it("空 #app + 已加载的 bundle → 白屏，理由点名挂载点", () => {
        const v = judgeVisibleDom(shellHtml(`<div id="app" data-bundle="loaded"></div>`));
        expect(v.mount).toEqual({ id: "app", empty: true });
        expect(v.blank).toBe(true);
        expect(v.reason).toContain("#app 是空的");
    });

    it("#root / #main 同样认", () => {
        expect(detectMount(`<body><div id="root"></div></body>`)).toEqual({ id: "root", empty: true });
        expect(detectMount(`<body><div id="main"></div></body>`)).toEqual({ id: "main", empty: true });
    });

    it("容器里有元素（还在加载转圈）不算空挂载点——不当成「没挂上」", () => {
        expect(detectMount(`<body><div id="app"><div class="loading"></div></div></body>`))
            .toEqual({ id: "app", empty: false });
    });

    it("空挂载点里的注释/空脚本不算内容（<!--v-if--> 这类占位标记别当内容）", () => {
        expect(detectMount(`<body><div id="app"><!--app-html--><script></script></div></body>`))
            .toEqual({ id: "app", empty: true });
    });

    it("没有这类容器时 mount=null，判定退回文本/元素数", () => {
        const v = judgeVisibleDom(shellHtml(`<section><p>${"内容".repeat(40)}</p></section>`));
        expect(v.mount).toBeNull();
        expect(v.blank).toBe(false);
    });
});

describe("可见文本口径：人眼看不见的东西一律不算字", () => {
    it("<script> 内容不算（内联脚本源码不是文本）", () => {
        expect(extractVisibleText(`<body><p>你好</p><script>var s = "脚本里的中文人眼看不到";</script></body>`)).toBe("你好");
    });

    it("<style> 内容不算", () => {
        expect(extractVisibleText(`<body><div>看这里</div><style>.a{content:"样式里的中文"}</style></body>`)).toBe("看这里");
    });

    it("<noscript> 内容不算（脚本开着的时候它根本不渲染）", () => {
        const html = shellHtml(`<div id="app"></div>`, { noscript: true });
        expect(html).toContain("请启用 JavaScript");
        expect(extractVisibleText(html)).toBe("");
        expect(judgeVisibleDom(html).blank).toBe(true);
    });

    it("<template> 内容不算", () => {
        expect(extractVisibleText(`<body><template><li>模板里的字</li></template><p>真的字</p></body>`)).toBe("真的字");
    });

    it("HTML 注释不算（注释里的标签也不能撑起元素数）", () => {
        const html = `<body><!-- <li>注释掉的待办</li> <p>注释里的中文</p> --><div id="app"></div></body>`;
        expect(extractVisibleText(html)).toBe("");
        expect(countElements(html)).toBe(2);                  // body + div#app（注释里的 li/p 不算）
        expect(judgeVisibleDom(html).blank).toBe(true);
    });

    it("未闭合的 <script>/<style> 吃到文末——脚本源码绝不冒充文本", () => {
        expect(extractVisibleText(`<body><p>真字</p><script>var x = "没闭合的脚本里的中文"`)).toBe("真字");
        expect(extractVisibleText(`<body><p>真字</p><style>.a{color:red}`)).toBe("真字");
    });

    it("空白实体与零宽字符不算字（&#160; / &nbsp; / U+200B 满屏也是白屏）", () => {
        expect(extractVisibleText(`<body><div>&nbsp;&#160;&#xA0;</div></body>`)).toBe("");
        expect(extractVisibleText(`<body><div>${"\u200b".repeat(50)}</div></body>`)).toBe("");
        expect(judgeVisibleDom(`<body><div id="app">&nbsp;${"\u200b".repeat(80)}</div></body>`).textLen).toBe(0);
    });

    it("实体解码后照常算字（&amp; 之类是真看得见的）", () => {
        expect(extractVisibleText(`<body><p>待办 &amp; 已完成 &middot; 共 3 项</p></body>`)).toBe("待办 & 已完成 &middot; 共 3 项");
    });

    it("没有 body 的片段：内联脚本里写着 \"<head>\" 也不许把后面的正文吃掉", () => {
        // 顺序坑：先丢 script 再丢 head。反过来的话，未闭合 head 规则会从脚本字符串里的
        // "<head>" 一路吃到文末 → 后面那段真文字消失 → 有内容的页面被判白屏。
        expect(extractVisibleText(`<script>var s = "<head>";</script><div>可见的字</div>`)).toBe("可见的字");
        expect(judgeVisibleDom(`<script>var s = "<head>";</script><div>${"字".repeat(40)}</div>`).blank).toBe(true); // 元素太少仍判白屏
    });

    it("标题里的字不进可见文本，但 extractTitle 抓得到（证据与判定分离）", () => {
        expect(extractTitle(shellHtml(`<div id="app"></div>`))).toBe(TITLE_TEXT);
        expect(extractVisibleText(shellHtml(`<div id="app"></div>`))).toBe("");
    });
});

describe("可见文本口径：真内容必须放行（别把有内容的判成白屏）", () => {
    it("渲染出文字的页面 → 非白屏，文本就是人眼看见的那段", () => {
        const v = judgeVisibleDom(CONTENT_DOM);
        expect(v.blank).toBe(false);
        expect(v.reason).toBeNull();
        expect(v.text).toContain("买牛奶");
        expect(v.textLen).toBeGreaterThanOrEqual(MIN_VISIBLE_TEXT);
        expect(v.elCount).toBeGreaterThanOrEqual(MIN_ELEMENTS);
        expect(v.mount).toEqual({ id: "app", empty: false });
        expect(judgeDom(CONTENT_DOM).blank).toBe(false);
    });

    it("刚好到阈值字数就放行（阈值是「少于」不是「不多于」）", () => {
        const fills = Array.from({ length: 12 }, () => `<span></span>`).join("");
        const html = `<body><div id="app">${fills}<p>${"字".repeat(MIN_VISIBLE_TEXT)}</p></div></body>`;
        const v = judgeVisibleDom(html);
        expect(v.textLen).toBe(MIN_VISIBLE_TEXT);
        expect(v.elCount).toBeGreaterThanOrEqual(MIN_ELEMENTS);
        expect(v.blank).toBe(false);
    });

    it("少一个字就判白屏（阈值咬得住）", () => {
        const fills = Array.from({ length: 12 }, () => `<span></span>`).join("");
        const html = `<body><div id="app">${fills}<p>${"字".repeat(MIN_VISIBLE_TEXT - 1)}</p></div></body>`;
        const v = judgeVisibleDom(html);
        expect(v.textLen).toBe(MIN_VISIBLE_TEXT - 1);
        expect(v.blank).toBe(true);
        expect(v.reason).toContain(`< ${MIN_VISIBLE_TEXT}`);
    });

    it("老口径「元素稀疏即使文本长也判空」保留（render-smoke.ts:33 的行为不回退）", () => {
        const v = judgeVisibleDom(`<html><body><p>${"短".repeat(300)}</p></body></html>`);
        expect(v.textLen).toBe(300);
        expect(v.elCount).toBe(3);
        expect(v.blank).toBe(true);
    });
});

describe("Edge 调用参数：headless 铁律（绝不能弹出真窗口）", () => {
    it("buildEdgeArgs 第一项永远是 --headless=new，且带齐 no-sandbox 与专属 profile", () => {
        const args = buildEdgeArgs("C:\\tmp\\cf-profile", ["--virtual-time-budget=6000", "--dump-dom", "http://127.0.0.1:1/"]);
        expect(args[0]).toBe("--headless=new");
        expect(args).toContain("--disable-gpu");
        expect(args).toContain("--no-sandbox");
        expect(args).toContain("--user-data-dir=C:\\tmp\\cf-profile");
        expect(args.filter(a => a.startsWith("--headless")).length).toBe(1);   // 只允许 headless=new 一种
        expect(args.some(a => a.includes("--headless=old"))).toBe(false);
    });

    it("调用方传进来的参数不会被顶掉（顺序：铁律在前，业务参数在后）", () => {
        const args = buildEdgeArgs("/tmp/p", ["--dump-dom", "http://x/"]);
        expect(args.slice(-2)).toEqual(["--dump-dom", "http://x/"]);
    });
});

// ============================================================
// B. 集成：真 Bun 静态服 + 真 headless Edge dump-dom（本文件唯一一条慢用例）
// ============================================================

const EDGE_CANDIDATES = [
    path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
];

function findEdge(): string | null {
    for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
    return null;
}

const edgeExe = findEdge();

/** 把 index.html + main.js 落到临时目录（脚手架里的 script src 指向本项目自己那个 main.js） */
function writeFixture(root: string, name: string, mainJs: string): string {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    const html = shellHtml(`<div id="app"></div>`, { noscript: true, scriptSrc: `/${name}/main.js` });
    fs.writeFileSync(path.join(dir, "index.html"), html, "utf-8");
    fs.writeFileSync(path.join(dir, "main.js"), mainJs, "utf-8");
    return dir;
}

/**
 * 真跑一次 headless Edge dump-dom（铁律参数来自 buildEdgeArgs；profile 建在临时目录里，用完即删）。
 *
 * ⚠️ 必须**异步**起进程：本进程里还开着 fixture 的 Bun.serve（事件循环同一条），
 *    用 execFileSync 会把事件循环堵死 → 服务器答不了 Edge 的请求、Edge 等不到页面 →
 *    双方互相等（9/18 实测：卡满 120s 超时，stdout 为空，看起来像"Edge 挂了"，其实是自己堵自己）。
 *    harness 也是这个姿势：eval/harness/exec.ts:70 的 execCapture 是 spawn + Promise。
 */
async function dumpDomWithRealEdge(root: string, exe: string, url: string): Promise<string> {
    const profile = path.join(root, `edge-profile-${Date.now()}`);
    const args = buildEdgeArgs(profile, ["--disable-dev-shm-usage", "--virtual-time-budget=6000", "--dump-dom", url]);
    const child = Bun.spawn([exe, ...args], { stdout: "pipe", stderr: "pipe" });
    // 两条流都要读：只读 stdout 时，Edge 那堆 stderr 日志会把管道填满、把它自己堵死
    const stdoutP = new Response(child.stdout).text();
    const stderrP = new Response(child.stderr).text();
    const killer = setTimeout(() => { try { child.kill(); } catch { /* 已经退出 */ } }, 90_000);
    try {
        const exitCode = await child.exited;
        const dom = await stdoutP;
        const err = await stderrP;
        if (exitCode !== 0 || dom.trim().length === 0) {
            throw new Error(`headless Edge 没吐出 DOM（exit=${exitCode}）：${err.slice(-400)}`);
        }
        return dom;
    } finally {
        clearTimeout(killer);
        try { child.kill(); } catch { /* 已经退出 */ }
        try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 }); }
        catch { /* profile 还被 Edge 收尾占着：整个临时目录随 _tmp.ts 一起清 */ }
    }
}

describe("集成：真 headless Edge —— 白屏必须判白屏，有内容必须判有内容", () => {
    // 没装 Edge 就跳过（不假装通过）；本机有 Edge，会真跑
    test.skipIf(edgeExe === null)(`真渲染判定（${edgeExe === null ? "无 Edge：跳过" : "headless Edge 真跑"}）`, async () => {
        const exe = edgeExe;
        if (exe === null) throw new Error("unreachable：skipIf 没生效");
        const root = tmpDir("cf-rendergate");
        // 白屏 fixture：壳 + 长标题 + 空 #app；bundle 真执行（把 data-bundle 写到 <html> 上，证明不是资源没加载）
        const blankDir = writeFixture(root, "blank", `document.documentElement.dataset.bundle = "loaded";\n`);
        // 有内容 fixture：同一个壳，JS 真把待办清单渲染进 #app
        const contentDir = writeFixture(root, "content",
            `document.getElementById("app").innerHTML = ${JSON.stringify(APP_INNER_HTML)};\n`
            + `document.documentElement.dataset.bundle = "loaded";\n`);

        const server = Bun.serve({
            port: 0,
            fetch(req) {
                const u = new URL(req.url);
                const blank = u.pathname === "/blank" || u.pathname.startsWith("/blank/");
                const dir = blank ? blankDir : contentDir;
                if (u.pathname === "/blank" || u.pathname === "/content") {
                    return new Response(Bun.file(path.join(dir, "index.html")), { headers: { "content-type": "text/html; charset=utf-8" } });
                }
                const rel = u.pathname.replace(/^\/(blank|content)\//, "");
                const file = path.join(dir, rel);
                if (!fs.existsSync(file)) return new Response("404", { status: 404 });
                const type = file.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/plain; charset=utf-8";
                return new Response(Bun.file(file), { headers: { "content-type": type } });
            },
        });
        try {
            const base = `http://127.0.0.1:${server.port}`;
            const blankDom = await dumpDomWithRealEdge(root, exe, `${base}/blank`);
            const contentDom = await dumpDomWithRealEdge(root, exe, `${base}/content`);

            const bv = judgeVisibleDom(blankDom);
            const lb = legacyJudgeDom(blankDom);
            const cv = judgeVisibleDom(contentDom);
            console.log(`  [真跑] 白屏页 dump 长度 ${blankDom.length}／bundle 已执行=${blankDom.includes('data-bundle="loaded"')}`
                + `\n  [真跑] 白屏页 判定：textLen=${bv.textLen} elCount=${bv.elCount} blank=${bv.blank} mount=${JSON.stringify(bv.mount)}`
                + `\n  [真跑] 白屏页 reason：${bv.reason}`
                + `\n  [真跑] 白屏页 旧口径对照：textLen=${lb.textLen} elCount=${lb.elCount} blank=${lb.blank}`
                + `\n  [真跑] 有内容页 判定：textLen=${cv.textLen} elCount=${cv.elCount} blank=${cv.blank} 文本="${cv.text.slice(0, 60)}"`);

            // —— 白屏页：bundle 执行过、标题在 DOM 里，仍然一个字都不该有 ——
            expect(blankDom).toContain('data-bundle="loaded"');   // JS 真的跑了（不是资源没加载）
            expect(blankDom).toContain(TITLE_TEXT);               // 标题在 DOM 里（老口径的"字"来源）
            expect(blankDom).toContain('id="app"');               // 挂载点的壳在
            expect(bv.textLen).toBe(0);
            expect(bv.mount).toEqual({ id: "app", empty: true });
            expect(bv.blank).toBe(true);
            expect(judgeDom(blankDom).blank).toBe(true);
            expect(lb.blank).toBe(false);                         // ★ 老口径会把这一页放过去

            // —— 有内容页：同一个壳、同样的标题，JS 渲染出文字 → 必须放行 ——
            expect(contentDom).toContain('data-bundle="loaded"');
            expect(cv.text).toContain("买牛奶");
            expect(cv.textLen).toBeGreaterThanOrEqual(MIN_VISIBLE_TEXT);
            expect(cv.blank).toBe(false);
            expect(judgeDom(contentDom).blank).toBe(false);
        } finally {
            server.stop(true);
        }
    }, 180_000);
});

// 临时目录（fixture + Edge profile）收尾清理 —— 必须注册在文件末尾（_tmp.ts 的钩子按注册顺序跑）
cleanupTempDirsAfterTests();
