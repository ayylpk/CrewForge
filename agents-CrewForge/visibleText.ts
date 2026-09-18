// ============================================================
// visibleText.ts —— "人眼能看见的字"的唯一口径（纯函数，零依赖，不碰 DOM API）
//
//   为什么单独一个文件（9/18）：白屏判定原先长在 renderGate.judgeDom 里，而它在算
//   「可见文本」时**把 <title> 和整段 <head> 都算成了字**：
//       html.replace(/<script>…/, " ").replace(/<style>…/, " ").replace(/<[^>]+>/g, " ").trim().length
//   —— 「去掉标签剩下的就是文本」这句在 <head> 上不成立：title/meta 里的字人眼一个也看不见。
//   实测数字（都不是推理，见 developerAgent/tests/render-gate.test.ts）：
//     · 真 headless Edge 跑出来的白屏页（壳 14 个元素 + <title> 32 字 + 空 #app + bundle 已执行）：
//         旧口径 textLen=54 / elCount=15 / blank=false（白屏蒙混过关）
//         新口径 textLen=0  / elCount=13 / blank=true
//     · 今天真实跑挂的 s4d-todo-lite 页面（harness 自己留的 page.home-edge.stdout.log 原始 dump）：
//         旧口径 textLen=12 —— **这 12 个字全部来自 <title>CrewForge 应用</title>**，body 里一个字没有；
//         那一页当时靠"元素 8<12 且 12<24"两条兜底仍然判了白屏，所以坑是**潜伏**的：
//         标题再长一点、元素再多几个（dev 起服比构建产物多注入几个标签），白屏就会被判成"有内容"。
//   eval 侧早就绕开了这个坑，并在代码里留了路标：
//       eval/harness/checks.ts:477  「只取 <body>：<title>便签应用</title> 这类 head 文本
//                                    不是"渲染出来的内容"，旧系统的 renderGate 把标题算进
//                                    可见文本，会把白屏判成"有 4 个字"——这里不重复那个错。」
//   那个文件是已提交的绿色基线、本轮禁止改动，所以**不是**再抄第三份口径，而是：
//     · 本文件 = 唯一实现（比 harness 那份严：harness 只取 body，这里还排 noscript/template/
//       注释/不可见字符，并且认「SPA 挂载点为空的壳」）；
//     · renderGate.ts 只调用本文件，自己不再实现判定；
//     · 测试也只 import 本文件，不复制规则。
//   ⚠️ 待办（写给人看）：将来若允许改 eval/harness/checks.ts，应让它改调 extractVisibleText()，
//      两边就再也不会有第三种口径。
//
//   口径（"人眼能看见的字"到底怎么算）：
//     ① 范围：有 <body> 就只取 body 内（head/title 天然出局）；没有 body 就整篇减 head。
//     ② 整段丢掉：注释、script、style、noscript、template、title（内容+标签一起丢，不是留标签）。
//     ③ 不闭合的 <script>/<style> 一律吃到文末 —— 宁可判空，不可把脚本源码当"字"。
//     ④ 实体解码（单趟）：&#160;/&nbsp; 之类渲染出来是空白 → 当空白；amp/lt/gt/quot/apos 按一个字符算；
//        未知命名实体原样保留（浏览器就是这么原样显示的"&foo;"，那确实是看得见的字）。
//     ⑤ 零宽 / 软连字符等不可见字符清掉（满屏 \u200b 的页面和空白页在眼睛上没区别）。
// ============================================================

/** 可见文本阈值：低于这个字数就算"没字"。harness 的 minTextLength 断言用的就是这个量级。 */
export const MIN_VISIBLE_TEXT = 24;

/** 元素数阈值（沿用 9/8 的老口径，不改：真 vue 页面不可能只有几个元素）。script/style 内容不算元素。 */
export const MIN_ELEMENTS = 12;

/** SPA 挂载点：壳写好了、bundle 也加载了，但这几个容器是空的 = 组件根本没挂上 → 白屏。 */
export const MOUNT_IDS = ["app", "root", "main"] as const;

/** 整段（含标签）要丢掉的标签：它们的内容都不是"渲染给人看的内容" */
const CONTENT_INVISIBLE_TAGS = ["script", "style", "noscript", "template", "title"] as const;

/** 元素计数时整段丢掉的标签：注释 + 不会被渲染（或不是元素）的脚本样式 */
const NON_ELEMENT_TAGS = ["script", "style", "noscript", "template"] as const;

export interface MountInfo {
    /** 命中的挂载点 id（app / root / main） */
    id: string;
    /** 容器存在但里面既没有元素也没有可见文本 → true（壳在、挂载没发生） */
    empty: boolean;
}

export interface VisibleVerdict {
    blank: boolean;
    /** body 里人眼能看见的字数（head/title/script/style/注释全不算） */
    textLen: number;
    /** 上面那段字本身（证据，报告里截断展示） */
    text: string;
    /** 整篇的标签数（口径见 MIN_ELEMENTS，不含 script/style/noscript/template 的内容） */
    elCount: number;
    /** 命中的 SPA 挂载点；没有这类容器=null */
    mount: MountInfo | null;
    /** blank=true 时点名踩了哪条；blank=false 时 null */
    reason: string | null;
}

/** 去注释（不闭合的吃到文末——dump 里出现未闭合注释时，别让它后面的标签变成"字"） */
export function stripComments(html: string): string {
    return html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<!--[\s\S]*$/g, " ");
}

/** 整段丢掉若干标签（先配对删，再吃掉未闭合的尾巴） */
export function stripElementsWithContent(html: string, tags: readonly string[]): string {
    let s = stripComments(html);
    for (const t of tags) {
        s = s.replace(new RegExp(`<${t}\\b[^>]*>[\\s\\S]*?<\\/${t}\\s*>`, "gi"), " ");
    }
    for (const t of tags) {
        // 未闭合：<script src=…> 之后是脚本源码（dump-dom 会把内联脚本原样吐出来）
        s = s.replace(new RegExp(`<${t}\\b[^>]*>[\\s\\S]*$`, "i"), " ");
    }
    return s;
}

/**
 * 可见范围：有 <body> 就只取 body 内（这是 harness 的口径，head 里的字天然不算）；
 * 没有 body（片段 / 异常 dump）就整篇减 head —— 绝不退回"整篇都算"。
 */
export function visibleScope(html: string): string {
    const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    if (body?.[1] !== undefined) return body[1];
    // 无 body（片段 / 异常 dump）：**先**丢掉不可见段落，**再**丢 head——
    // 顺序反了会踩坑：内联脚本里出现字符串 "<head>"（很可能有）时，未闭合 head 那条规则
    // 会把脚本后面的正文一起吃到文末 → 有内容的页面被判白屏。
    return stripElementsWithContent(stripElementsWithContent(html, CONTENT_INVISIBLE_TAGS), ["head"]);
}

/** 常见命名实体：渲染出来是"一个字符"的，按一个字符算（&amp; 不能当 5 个字） */
const NAMED_ENTITIES: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'",
    nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", zwnj: " ", zwj: " ", shy: " ", hairsp: " ",
};

/** 不可见码位（零宽 / 方向标记 / 行分隔 / BOM）：当空白 */
function isInvisibleCode(code: number): boolean {
    return (code >= 0x200b && code <= 0x200f) || code === 0x2028 || code === 0x2029 || code === 0x2060 || code === 0xfeff;
}

/**
 * 实体解码。★ **单趟**替换：分两趟会把 `&amp;lt;` 解成 `<`（浏览器只解一层，显示的是 `&lt;`）。
 * 命名实体只认上表那批；**未知命名实体原样保留**——浏览器就是原样显示 `&foo;` 的，那确实是看得见的字。
 */
function decodeEntities(s: string): string {
    return s.replace(/&(#(?:[xX][0-9a-fA-F]+|\d+)|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
        if (!body.startsWith("#")) return NAMED_ENTITIES[body.toLowerCase()] ?? m;
        const hex = /^#[xX]/.test(body);
        const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10_ffff) return m;      // 非法实体原样留着
        // C0/C1 控制符 + 各种空白 / 零宽：人眼看不见 → 当空白
        if (code < 0x20 || (code >= 0x7f && code <= 0xa0) || isInvisibleCode(code)) return " ";
        try { return String.fromCodePoint(code); } catch { return m; }
    });
}

/** 塌缩空白 + 清掉不可见字符（零宽、软连字符、BOM）——满屏零宽字符的页面等于白屏 */
function collapse(s: string): string {
    return s.replace(/[\u200b-\u200f\u2060\ufeff\u00ad]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * ★ 核心：抽"人眼能看见的文本"。head/title/script/style/noscript/template/注释全部不算。
 * 返回的是塌缩过的可见文本（空字符串 = 一个字都看不见）。
 */
export function extractVisibleText(html: string): string {
    return collapse(decodeEntities(stripElementsWithContent(visibleScope(html), CONTENT_INVISIBLE_TAGS).replace(/<[^>]*>/g, " ")));
}

/** 抽 <title>（报告里当证据用，**不参与**白屏判定：标题不是渲染出来的内容） */
export function extractTitle(html: string): string | null {
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(stripComments(html));
    const t = m?.[1]?.replace(/<[^>]*>/g, " ").trim();
    return t !== undefined && t.length > 0 ? collapse(decodeEntities(t)) || null : null;
}

/** 元素计数（老口径：整篇标签数，script/style/noscript/template 内容与注释不算） */
export function countElements(html: string): number {
    return (stripElementsWithContent(html, NON_ELEMENT_TAGS).match(/<[a-zA-Z][^>]*>/g) ?? []).length;
}

/**
 * 找 SPA 挂载点：`id="app"|"root"|"main"` 的容器存在却是空的 → 壳写好但组件没挂上。
 * 判"空"用的是「容器开标签到第一个同名闭标签之间既无元素也无可见文本」，所以
 * `<div id="app"><div class="spin"></div></div>`（还在加载）不算空、`<div id="app"></div>` 算空。
 * 只认第一个命中的 id（app → root → main），避免一个页面里到处 #main 造成乱报。
 */
export function detectMount(html: string): MountInfo | null {
    const scoped = stripElementsWithContent(visibleScope(html), CONTENT_INVISIBLE_TAGS);
    for (const id of MOUNT_IDS) {
        const open = new RegExp(`<([a-zA-Z][\\w-]*)\\b[^>]*\\bid\\s*=\\s*["']?${id}["']?[^>]*>`, "i").exec(scoped);
        if (!open) continue;
        const tag = open[1] ?? "div";
        const rest = scoped.slice(open.index + open[0].length);
        const close = new RegExp(`</${tag}\\s*>`, "i").exec(rest);
        const inner = close ? rest.slice(0, close.index) : rest;
        const hasElement = /<[a-zA-Z][^>]*>/.test(inner);
        const textLen = extractVisibleText(inner).length;
        return { id, empty: !hasElement && textLen === 0 };
    }
    return null;
}

/**
 * ★ 白屏判定（renderGate 的"眼睛"）。一条都别漏：
 *   ① body 可见文本 < 24 字（head/title/script/style/noscript/template/注释全不算）；
 *   ② 或 SPA 挂载点存在却是空的（壳在、bundle 在、容器里什么都没有 → 路由/挂载没生效）；
 *   ③ 或整篇元素数 < 12（老口径，保留：真页面不会只有几个元素）。
 * 任一命中 = blank。宁可报白屏让人去查，也不让白屏冒充"有内容"——REPAIR 提示会指向
 * 路由登记/组件导出/字段名，指错方向比多问一句贵得多。
 */
export function judgeVisibleDom(html: string): VisibleVerdict {
    const text = extractVisibleText(html);
    const textLen = text.length;
    const elCount = countElements(html);
    const mount = detectMount(html);
    const blank = textLen < MIN_VISIBLE_TEXT || (mount?.empty ?? false) || elCount < MIN_ELEMENTS;
    const reasons: string[] = [];
    if (textLen < MIN_VISIBLE_TEXT) reasons.push(`可见文本 ${textLen} 字 < ${MIN_VISIBLE_TEXT}（标题/脚本/样式/注释都不算文本）`);
    if (mount?.empty) reasons.push(`SPA 挂载点 #${mount.id} 是空的（壳在、组件没挂上）`);
    if (elCount < MIN_ELEMENTS) reasons.push(`元素 ${elCount} 个 < ${MIN_ELEMENTS}`);
    return { blank, textLen, text, elCount, mount, reason: blank ? reasons.join("；") : null };
}
