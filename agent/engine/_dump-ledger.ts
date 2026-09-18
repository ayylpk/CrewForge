// _dump-ledger.ts —— 一次性取证脚本（只读）：dump 开发流账本 sqlite 的事件/等待窗口/状态
// 跑法：bun run _dump-ledger.ts runs/p20/_developer/20-p1.db
import { Database } from "bun:sqlite";

const db = new Database(process.argv[2]!, { readonly: true });
for (const t of ["tool_call", "completed_tool_call", "node_event", "failure", "event", "test_wait", "task_state", "seen_message", "violation"]) {
    console.log(`\n===== ${t} =====`);
    try {
        // SELECT * 兼容任意列形状，逐行 JSON 打印
        for (const row of db.query(`SELECT * FROM ${t} ORDER BY rowid`).all()) {
            console.log(JSON.stringify(row));
        }
    } catch (e) {
        console.log(`(读表失败：${(e as Error).message})`);
    }
}
db.close();
