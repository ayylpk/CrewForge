// ============================================================
// ownership-smoke.ts —— 写盘纪律自测（零 LLM）
//
//   ① 逃逸路径必拒（绝对路径 / ..）
//   ② ★ 引擎拥有件必拒（main.ts / App.vue / router / style.css / index.html）
//   ③ ★ 越界写盘必拒且**附候选**（这是 p1「四套目录」的病根）
//   ④ owner 登记：同任务可重入、他人占用即拒、释放后可接手
// ============================================================

import { decideWrite, isEngineOwnedFile, OwnershipRegistry, normPath, type WriteDecision } from "./ownership";
import { SPRING_VUE } from "../stacks/profile";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string): void {
    if (cond) { pass++; console.log(`  ✓ ${msg}`); }
    else { fail++; console.log(`  ✗ ${msg}`); }
}
/** 失败码（成功时给占位），便于断言可读 */
function failCode(d: WriteDecision): string { return d.ok ? "(ok)" : d.code; }
function candidatesOf(d: WriteDecision): string[] { return d.ok ? [] : (d.candidates ?? []); }

const PLAN = [
    "backend/src/main/java/com/demo/AccountController.java",
    "backend/src/main/java/com/demo/AccountService.java",
];

console.log("=== ① 逃逸 ===");
{
    ok(failCode(decideWrite({ path: "../../etc/passwd", taskId: "T1", plannedFiles: PLAN })) === "escape", ".. 逃逸被拒");
    ok(failCode(decideWrite({ path: "C:/Windows/system32/x.txt", taskId: "T1", plannedFiles: PLAN })) === "escape", "绝对路径被拒");
    ok(failCode(decideWrite({ path: "", taskId: "T1", plannedFiles: PLAN })) === "escape", "空路径被拒");
    ok(normPath(".\\A\\B.java") === "a/b.java", "路径归一（反斜杠/大小写）");
}

console.log("=== ② 引擎拥有件 ===");
{
    for (const p of ["frontend/src/main.ts", "frontend/src/App.vue", "frontend/src/router/index.ts", "frontend/src/style.css", "frontend/index.html"]) {
        const d = decideWrite({ path: p, taskId: "T1-F", plannedFiles: [p], profile: SPRING_VUE });
        ok(failCode(d) === "engine_owned", `引擎拥有件被拒：${p}`);
    }
    ok(isEngineOwnedFile("BACKEND/src/app.js"), "历史遗留引擎件（Express app.js）仍被识别");
    ok(!isEngineOwnedFile("frontend/src/views/Login.vue"), "普通页面不是引擎件");
    ok(decideWrite({ path: "backend/src/main/java/com/demo/AccountController.java", taskId: "T1", plannedFiles: PLAN, profile: SPRING_VUE }).ok,
        "任务自己声明的文件放行");
}

console.log("=== ③ 越界写盘 + 候选 ===");
{
    const d = decideWrite({ path: "src/main/java/com/demo/AccountController.java", taskId: "T1", plannedFiles: PLAN });
    ok(!d.ok && failCode(d) === "out_of_plan", "★ 不在声明清单里 → 拒绝（登记制）");
    ok(candidatesOf(d).some(c => c.includes("AccountController.java")), `★ 附候选帮助改正：${candidatesOf(d).join(", ")}`);
    ok((d.ok ? "" : d.reason).includes("登记制"), "拒绝理由可读");
    // 空清单（老数据没声明 files）时不做越界判定，避免误杀
    ok(decideWrite({ path: "anything/ok.java", taskId: "T1", plannedFiles: [] }).ok, "清单为空时不做越界判定（不误杀老数据）");
}

console.log("=== ④ owner 登记 ===");
{
    const reg = new OwnershipRegistry();
    ok(reg.claim("a/B.java", "T1").ok, "首次认领成功");
    ok(reg.claim("a/b.java", "T1").ok, "★ 同任务重复认领（大小写归一后同一文件）允许吗——是，可重入");
    const other = reg.claim("a/B.java", "T2");
    ok(!other.ok && other.owner === "T1", `他人认领被拒并指明 owner：${other.reason}`);
    ok(reg.ownerOf("A/B.JAVA") === "T1", "ownerOf 大小写不敏感");
    reg.releaseTask("T1");
    ok(reg.ownerOf("a/b.java") === null, "释放后 owner 清空");
    ok(reg.claim("a/B.java", "T2").ok, "释放后他人可接手");
    ok(reg.snapshot().length === 1, "快照可观测");
}

console.log(`\n[ownership-smoke] 通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
