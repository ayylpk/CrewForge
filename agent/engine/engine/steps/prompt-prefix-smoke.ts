// ============================================================
// prompt-prefix-smoke.ts —— 提示词前缀稳定化回归（C-1，零 LLM）
//
//   为什么值得一条冒烟：上下文缓存是**前缀命中**，脚本里混进时间戳/UUID/随进度增长的
//   文件树，会让后续调用静默退化为全价。这条冒烟把"顺序固定 + 前缀可复现"钉成断言。
// ============================================================

import {
    buildStablePrefix, buildVolatileSection, assemblePrompt, fingerprint,
    findVolatileLeak, STABLE_ORDER,
} from "./promptPrefix";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string): void {
    if (cond) { pass++; console.log(`  ✓ ${msg}`); }
    else { fail++; console.log(`  ✗ ${msg}`); }
}

const ROLE = "# 角色\n你是后端实现 Agent。";
const BASE = "\n\n## 技术基线\nSpring Boot 3 + Java 17";
const CONTRACT = "\n\n## 项目契约\n- /api/accounts → AccountController.java";
const TREE = "\n\n## 项目文件树\nbackend/src/main/java/com/demo/A.java";

console.log("=== ① 顺序固定 ===");
{
    // 故意乱序传入（对象字面量按插入顺序），输出必须是 STABLE_ORDER 的顺序
    const a = buildStablePrefix({ toolProtocol: "[P]", fileTree: TREE, contract: CONTRACT, role: ROLE, baseline: BASE });
    const b = buildStablePrefix({ role: ROLE, baseline: BASE, contract: CONTRACT, fileTree: TREE, toolProtocol: "[P]" });
    ok(a === b, "键顺序不影响输出（装配顺序由 STABLE_ORDER 决定）");
    ok(a.indexOf(ROLE) < a.indexOf(BASE) && a.indexOf(BASE) < a.indexOf(CONTRACT) && a.indexOf(CONTRACT) < a.indexOf(TREE),
        "角色 → 基线 → 契约 → 文件树 的顺序成立");
    ok(a.lastIndexOf("[P]") === a.length - 3, "工具协议在稳定段末尾（老路无此段）");
    ok(STABLE_ORDER.join(",") === "role,baseline,contract,fileTree,toolProtocol", "STABLE_ORDER 未被误改");
}

console.log("=== ② 空段不留多余分隔符 ===");
{
    const a = buildStablePrefix({ role: ROLE, baseline: BASE });
    const b = buildStablePrefix({ role: ROLE, baseline: BASE, contract: "", fileTree: undefined });
    ok(a === b, "空/未提供段被跳过（字节级确定）");
    ok(buildStablePrefix({ role: ROLE }) === ROLE.trim(), "单段时无前后多余空白");
}

console.log("=== ③ 前缀可复现（缓存前提）===");
{
    const s = { role: ROLE, baseline: BASE, contract: CONTRACT, fileTree: TREE };
    const h1 = fingerprint(buildStablePrefix(s));
    const h2 = fingerprint(buildStablePrefix({ ...s }));
    ok(h1 === h2, "同输入 → 同指纹（同任务多次调用前缀一致）");
    const h3 = fingerprint(buildStablePrefix({ ...s, fileTree: TREE + "\nbackend/src/main/java/com/demo/B.java" }));
    ok(h3 !== h1, "★ 文件树一变指纹就变——这正是 C-3 必须把树做成任务级快照的原因");
}

console.log("=== ④ 易变段只许追加在后 ===");
{
    const stable = { role: ROLE, baseline: BASE, contract: CONTRACT, fileTree: TREE };
    const volatile = [`\n\n## 当前目标文件\nbackend/.../A.java`, `\n\n## 上次打回\n';' expected`];
    const full = assemblePrompt(stable, volatile);
    const prefix = buildStablePrefix(stable);
    ok(full.startsWith(prefix), "完整提示词以稳定前缀开头");
    ok(full.slice(prefix.length) === buildVolatileSection(volatile), "易变段原样追加在稳定段之后");
    ok(!prefix.includes("当前目标文件") && !prefix.includes("上次打回"), "易变内容不混入前缀");
    ok(fingerprint(buildStablePrefix(stable)) === fingerprint(prefix), "指纹只覆盖稳定段");
}

console.log("=== ⑤ 易变内容卫生检查 ===");
{
    ok(findVolatileLeak(buildStablePrefix({ role: ROLE, baseline: BASE })).length === 0, "干净稳定段无告警");
    ok(findVolatileLeak("生成时间 2026-09-10T12:33:05").includes("ISO 时间戳"), "ISO 时间戳被识别");
    ok(findVolatileLeak("thread 550e8400-e29b-41d4-a716-446655440000").includes("UUID"), "UUID 被识别");
    ok(findVolatileLeak("ts=1757482800000").includes("毫秒时间戳"), "毫秒时间戳被识别");
}

console.log(`\n[prompt-prefix-smoke] 通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
