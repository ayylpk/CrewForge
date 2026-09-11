// ============================================================
// final-gate-smoke.ts —— 交付关自测（零 LLM）
//
//   ① 无验证器栈 → done 但 **verified=false**（未验证 ≠ 通过）
//   ② 无可验证对象（任务缺 method/path）→ done + verified=false + 如实说明
//   ③ 跳过开关 → done + verified=false（不得冒充已验证）
//   ④ 验证通过 → done + verified=true + 报告落盘
//   ⑤ ★ 编译/启动/契约失败 → **failed**（项目不算完成）
//   ⑥ Docker 不可用（skipped_unverified）→ done + verified=false + 提示报告位置
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finalGate } from "./finalGate";
import type { RunVerifyResult } from "../exec/verify/runVerify";
import type { TaskLike } from "../ir/contract";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string): void {
    if (cond) { pass++; console.log(`  ✓ ${msg}`); }
    else { fail++; console.log(`  ✗ ${msg}`); }
}

const TASKS: TaskLike[] = [
    { id: "T1", layer: "backend", method: "POST", path: "/auth/login", title: "登录" },
    { id: "T2", layer: "backend", method: "GET", path: "/api/accounts", title: "账号列表" },
];
const DIRTY: TaskLike[] = [{ id: "T9", layer: "backend", method: "", path: "", title: "脏任务" }];

function fake(outcome: RunVerifyResult["outcome"], failures: string[] = []): (o: any) => Promise<RunVerifyResult> {
    return async () => ({
        outcome, checked: outcome !== "skipped_unverified", evidence: [], failures,
        cleaned: true, summary: `stub:${outcome}`, contract: undefined as any,
    } as RunVerifyResult);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cffinalgate-"));

async function main(): Promise<void> {
    console.log("=== ①/②/③ 未验证路径 ===");
    {
        const r1 = await finalGate({ projectDir: tmp, tasks: TASKS, stack: { techniques: { frontend: { framework: "Svelte", ui: "Skeleton" }, backend: { framework: "Gin" } } } });
        ok(r1.status === "done" && !r1.verified, `无验证器栈 → done 但未验证（${r1.summary.slice(0, 40)}）`);

        const r2 = await finalGate({ projectDir: tmp, tasks: DIRTY, verify: fake("ok") });
        ok(r2.status === "done" && !r2.verified, `无可验证对象 → done 但未验证（${r2.summary.slice(0, 40)}）`);
        ok(r2.summary.includes("未验证"), "摘要显式说明未验证");

        const r3 = await finalGate({ projectDir: tmp, tasks: TASKS, skip: true });
        ok(r3.status === "done" && !r3.verified && r3.summary.includes("不得对外宣称已验证"), "★ 跳过开关不冒充已验证");
    }

    console.log("=== ④ 验证通过 ===");
    {
        const r = await finalGate({ projectDir: tmp, tasks: TASKS, verify: fake("ok") });
        ok(r.status === "done" && r.verified, `验证通过 → done + verified=true（${r.summary}）`);
        ok(r.reportFile != null && fs.existsSync(r.reportFile), `报告落盘：${r.reportFile ? path.basename(r.reportFile) : "无"}`);
        const body = fs.readFileSync(r.reportFile!, "utf-8");
        ok(body.includes("结论：ok"), "报告含结论");
    }

    console.log("=== ⑤ 验证失败 → 项目不算完成 ===");
    {
        for (const oc of ["compile_error", "boot_failed", "contract_failed"] as const) {
            const r = await finalGate({ projectDir: tmp, tasks: TASKS, verify: fake(oc as any, ["SessionConfig.java:233 constructor cannot be applied"]) });
            ok(r.status === "failed" && !r.verified, `★ ${oc} → status=failed（项目不落 done）`);
            ok((r.summary.includes("未通过") && r.summary.includes("1 条失败原因")), `摘要含失败计数：${r.summary.slice(0, 50)}`);
        }
    }

    console.log("=== ⑥ Docker 不可用 ===");
    {
        const r = await finalGate({ projectDir: tmp, tasks: TASKS, verify: fake("skipped_unverified" as any) });
        ok(r.status === "done" && !r.verified, "Docker 不可用 → done 但未验证（不 brick 无 Docker 的机器）");
        ok(r.summary.includes("未验证 ≠ 通过"), `摘要写明未验证：${r.summary.slice(0, 50)}`);
    }

    console.log("=== ⑦ 验收 IR 文件优先于任务字段 ===");
    {
        const vdir = path.join(tmp, "_verify");
        fs.mkdirSync(vdir, { recursive: true });
        const file = path.join(vdir, "acceptance-p1.json");
        fs.writeFileSync(file, JSON.stringify({
            phase: 1, generatedAt: new Date().toISOString(), skipped: [],
            cases: [{ kind: "http", id: "from-file", request: { method: "GET", path: "/api/from-file" }, expect: { status: 200 } }],
        }), "utf-8");

        let seen: any[] = [];
        const r = await finalGate({
            projectDir: tmp, tasks: TASKS, acceptanceFiles: [file],
            verify: async (o) => { seen = o.cases; return { outcome: "ok", checked: true, evidence: [], failures: [], cleaned: true, summary: "stub:ok" } as RunVerifyResult; },
        });
        ok(seen.length === 1 && (seen[0] as any).request.path === "/api/from-file",
            "★ 用产物树落盘的验收 IR（architect 从 ExecTask 字段机械生成），不靠 task 猜");
        ok(r.verified && r.status === "done", "IR 来源下验证通过 → done + verified");

        let seen2: any[] = [];
        await finalGate({
            projectDir: tmp, tasks: TASKS, acceptanceFiles: [path.join(vdir, "nope.json")],
            verify: async (o) => { seen2 = o.cases; return { outcome: "ok", checked: true, evidence: [], failures: [], cleaned: true, summary: "s" } as RunVerifyResult; },
        });
        ok(seen2.length === 2, `IR 文件缺失时退回任务字段（${seen2.length} 条）`);
    }

    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败无妨 */ }
    console.log(`\n[final-gate-smoke] 通过 ${pass}，失败 ${fail}`);
    if (fail > 0) process.exit(1);
}

void main();
