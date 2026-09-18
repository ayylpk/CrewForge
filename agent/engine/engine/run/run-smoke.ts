// ============================================================
// run-smoke.ts —— 状态机 / Ledger / 调度器自测（M2，零 LLM）
//
//   ① 状态机：合法链、非法迁移抛错、无证据不许 verified、0 切片不算完成
//   ② 输入哈希：同输入同哈希、改输入改哈希
//   ③ 租约：别人持有不可抢、过期可回收
//   ④ ★ 崩溃恢复真机：子进程跑到第 3 个 step 时硬退出；父进程用同一库续跑，
//      断言「前两个 step 不重跑、第三个被回收后完成」——这是"可恢复"的物理证明
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { advance, canTransition, projectVerdict, hashInput, isReclaimable, stepId, type SliceState, type StepRecord } from "./state";
import { SqliteStepStore } from "./store";
import { runSteps } from "./scheduler";
import { runCommand } from "../exec/run";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string): void {
    if (cond) { pass++; console.log(`  ✓ ${msg}`); }
    else { fail++; console.log(`  ✗ ${msg}`); }
}
function throws(fn: () => unknown): boolean {
    try { fn(); return false; } catch { return true; }
}

console.log("=== ① 状态机 ===");
{
    let s: SliceState = { s: "planned" };
    s = advance(s, { e: "contract", contractRef: "c1" });
    s = advance(s, { e: "implement", attempt: 1 });
    s = advance(s, { e: "verify", evidenceCount: 2 });
    s = advance(s, { e: "finish", inputHash: "h1" });
    ok(s.s === "done", "合法链 planned→contracted→implemented→verified→done");
    ok(throws(() => advance({ s: "planned" }, { e: "finish", inputHash: "h" })), "★ 非法迁移 planned→done 抛错（不许悄悄跳过）");
    ok(throws(() => advance({ s: "implemented", attempt: 1 }, { e: "verify", evidenceCount: 0 })),
        "★ 无证据（evidenceCount=0）不允许进入 verified");
    ok(canTransition("blocked", "contracted") && !canTransition("done", "contracted"), "返工可回退、终态不可离开");
    ok(!projectVerdict([]).done && projectVerdict([]).reason.includes("0 个切片"), "★ 0 切片 = 不算完成");
    ok(!projectVerdict([{ s: "done", inputHash: "h" }, { s: "implemented", attempt: 1 }]).done, "有切片未完成 → 不完成");
    ok(projectVerdict([{ s: "done", inputHash: "h" }]).done, "全部 done → 完成");
}

console.log("=== ② 输入哈希 ===");
{
    ok(hashInput({ a: 1, b: [1, 2] }) === hashInput({ a: 1, b: [1, 2] }), "同输入同哈希");
    ok(hashInput({ a: 1 }) !== hashInput({ a: 2 }), "改输入即改哈希（缓存失效）");
    ok(hashInput({ a: undefined }) === hashInput({ a: null }), "undefined 归一为 null（不因缺键抖动）");
    ok(isReclaimable({ status: "running", leaseUntil: Date.now() - 1 } as StepRecord), "过期租约可回收");
    ok(!isReclaimable({ status: "running", leaseUntil: Date.now() + 60_000 } as StepRecord), "未过期租约不可抢");
    ok(!isReclaimable({ status: "ok", leaseUntil: null } as StepRecord), "已完成的 step 不可回收");
}

console.log("=== ③ Ledger 基础行为 ===");
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfrun-"));
    const store = new SqliteStepStore(path.join(dir, "ledger.sqlite"));
    const id = stepId("r1", "implement", "s1");
    const a = store.ensureStep({ id, runId: "r1", kind: "implement", sliceId: "s1", inputHash: "h1" });
    const b = store.ensureStep({ id, runId: "r1", kind: "implement", sliceId: "s1", inputHash: "h1" });
    ok(a.id === b.id && store.listByRun("r1").length === 1, "ensureStep 幂等（同 id 只有一行）");
    ok(store.claim(id, "w1", 60_000), "首次抢租约成功");
    ok(!store.claim(id, "w2", 60_000), "★ 别人持有租约时抢不到");
    store.finish(id, "ok", { resultJson: "{}", evidenceJson: "{}", durationMs: 12 });
    ok(store.isCachedOk(id, "h1"), "完成 + 同 inputHash → 缓存命中");
    ok(!store.isCachedOk(id, "h2"), "★ inputHash 变了 → 缓存失效（必须重跑）");

    store.setSliceState("r1", "s1", JSON.stringify({ s: "done", inputHash: "h1" }));
    ok(store.getSliceStates("r1")[0]!.stateJson.includes("done"), "切片状态可落库读回");
    store.appendEvent("r1", "step_ok", JSON.stringify({ id }));
    ok(store.listEvents("r1").length === 1 && store.listEvents("r1")[0]!.type === "step_ok", "事件流追加/读取");
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log("=== ④ 崩溃恢复真机 ===");
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfcrash-"));
    const dbPath = path.join(dir, "ledger.sqlite");
    const execLog = path.join(dir, "exec.log");
    fs.writeFileSync(execLog, "", "utf-8");
    const child = path.resolve(import.meta.dir, "crash-child.ts");
    const bun = process.platform === "win32" ? "bun.exe" : "bun";

    const r = await runCommand(bun, [child, dbPath, "runX", execLog], { cwd: dir, timeoutMs: 120_000, env: { PATH: process.env.PATH ?? "" } });
    ok(r.exitCode === 99, `子进程按预期硬退出（exit=${r.exitCode}）`);

    const after = fs.readFileSync(execLog, "utf-8").trim().split(/\r?\n/).filter(Boolean);
    ok(after.join(",") === "one,two,three", `子进程执行轨迹 = one,two,three（实际 ${after.join(",")}）`);

    const store = new SqliteStepStore(dbPath);
    const rows = store.listByRun("runX");
    const byKind = (k: string) => rows.find(x => x.kind === k)!;
    ok(byKind("one").status === "ok" && byKind("two").status === "ok", "前两个 step 已落库为 ok");
    ok(byKind("three").status === "running", "★ 崩溃的 step 停在 running（没被伪装成完成）");
    // 崩溃恢复不是瞬时的：租约未到期时**抢不到是正确的**（别人可能只是慢，不是死了）。
    // 这里先断言"此刻还不可回收"，等租约过期再续跑——顺便把这条语义钉成回归。
    const leaseBefore = byKind("three").leaseUntil;
    ok(leaseBefore != null && leaseBefore >= Date.now(), "★ 租约未到期 → 此刻不可抢（防误判慢进程为死进程）");
    await new Promise(r => setTimeout(r, 400));
    const leaseAfter = byKind("three").leaseUntil;
    ok(leaseAfter != null && leaseAfter < Date.now(), "租约过期后可回收（崩溃进程被正确判死）");

    // 父进程续跑：同一批任务、同一 runId
    const mk = (name: string) => ({
        kind: name, input: { runId: "runX", name },
        run: async () => {
            fs.appendFileSync(execLog, `${name}\n`, "utf-8");
            return { ok: true, result: { name }, evidence: { cmd: `echo ${name}`, exitCode: 0 } };
        },
    });
    const res = await runSteps({
        store, runId: "runX", workerId: "parent", concurrency: 1, leaseMs: 5_000,
        tasks: [mk("one"), mk("two"), mk("three")],
    });
    store.close();

    ok(res.cached.length === 2 && res.reclaimed.length === 1, `★ 前两个吃缓存（cached=${res.cached.length}），第三个被回收续跑（reclaimed=${res.reclaimed.length}）`);
    ok(res.executed.length === 1 && res.executed[0]!.endsWith(":three"), `只重跑了崩溃的 step（executed=${res.executed.join(",")}）`);
    const finalLog = fs.readFileSync(execLog, "utf-8").trim().split(/\r?\n/).filter(Boolean);
    ok(finalLog.filter(x => x === "one").length === 1 && finalLog.filter(x => x === "two").length === 1,
        `★ 已验证的 step 没有重跑（one/two 各只出现 1 次；实际 ${finalLog.join(",")}）`);
    ok(finalLog.filter(x => x === "three").length === 2, "崩溃的 step 重跑了一次并成功");

    const store2 = new SqliteStepStore(dbPath);
    ok(store2.listByRun("runX").every(x => x.status === "ok"), "续跑后全部 step 为 ok");
    store2.close();
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log("=== ⑤ 预算与熔断（不许假装完成） ===");
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfbudget-"));
    const store = new SqliteStepStore(path.join(dir, "l.sqlite"));
    let runs = 0;
    const mk = (name: string) => ({ kind: name, input: { name }, run: async () => { runs++; return { ok: true }; } });
    const res = await runSteps({
        store, runId: "rb", workerId: "w", concurrency: 1, budget: { maxSteps: 2 },
        tasks: [mk("a"), mk("b"), mk("c"), mk("d")],
    });
    store.close();
    ok(res.budgetExceeded, "★ 超预算被标记（不静默继续烧）");
    ok(runs === 2 && res.executed.length === 2, `只执行了预算内的 2 个 step（实际 ${runs}）`);
    const store2 = new SqliteStepStore(path.join(dir, "l.sqlite"));
    const pending = store2.listByRun("rb").filter(x => x.status === "pending").length;
    store2.close();
    ok(pending === 2, `剩余 2 个 step 保持 pending（未执行 ≠ 完成；实际 ${pending}）`);
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n[run-smoke] 通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
