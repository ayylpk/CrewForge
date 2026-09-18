// ============================================================
// crash-child.ts —— 崩溃模拟子进程（仅冒烟用，零 LLM）
//
//   用途：验证"进程被杀后能从 Ledger 续跑，且已验证的 step 不重跑"。
//   行为：按顺序跑 3 个 step，第 3 个在**执行中**硬退出（模拟 OOM/超时被杀），
//        留下 status=running + 短租约，由父进程回收续跑。
//
//   跑法：bun run engine/run/crash-child.ts <dbPath> <runId> <execLogPath>
// ============================================================

import fs from "node:fs";
import { SqliteStepStore } from "./store";
import { runSteps } from "./scheduler";

const [dbPath, runId, execLog] = process.argv.slice(2);
if (!dbPath || !runId || !execLog) {
    console.error("用法: crash-child.ts <dbPath> <runId> <execLogPath>");
    process.exit(2);
}

const store = new SqliteStepStore(dbPath);
const note = (name: string) => fs.appendFileSync(execLog, `${name}\n`, "utf-8");

const make = (name: string, crash = false) => ({
    kind: name,
    input: { runId, name },
    run: async () => {
        note(name);
        if (crash) {
            // 硬退出：不 finish、不留遗言——step 会停在 running + 短租约
            process.exit(99);
        }
        return { ok: true, result: { name }, evidence: { cmd: `echo ${name}`, exitCode: 0 } };
    },
});

await runSteps({
    store, runId, workerId: "child", concurrency: 1, leaseMs: 300,
    tasks: [make("one"), make("two"), make("three", true)],
});
store.close();
console.error("不该走到这里：崩溃 step 没触发退出");
process.exit(3);
