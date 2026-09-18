/*
 * engine-postmortem.ts —— 引擎状态库的针对性验尸（只读）
 * ---------------------------------------------------------------------------
 * 跑法（cwd = CrewForge）：
 *   bun run scripts/engine-postmortem.ts <某个 .db 路径>
 *
 * 回答一个问题：这个 task 拿了 55 次 LLM 调用，为什么一个字都没写到盘上？
 * 关键列：tool_call.changed_files_json（每次调用真正改动的文件）
 */
import { Database } from "bun:sqlite";

const dbPath = process.argv[2]!;
const db = new Database(dbPath, { readonly: true });
const cut = (s: unknown, n = 700) => {
    const t = String(s ?? "");
    return t.length > n ? t.slice(0, n) + ` …[+${t.length - n}]` : t;
};
const ts = (ms: unknown) => (ms ? new Date(Number(ms) + 8 * 3600_000).toISOString().slice(11, 19) : "-");

console.log("############ task_state ############");
for (const r of db.query(`SELECT * FROM task_state`).all() as any[]) {
    console.log(JSON.stringify(r, null, 2));
}

console.log("\n############ 最近 8 个 checkpoint ############");
for (const r of db.query(`SELECT * FROM checkpoint ORDER BY id DESC LIMIT 8`).all() as any[]) {
    console.log(
        `[${ts(r.at)}] node=${r.node} phase=${r.phase} status=${r.status} ` +
        `planned=${r.llm_calls_planned} completed=${r.llm_calls_completed} tool_calls=${r.tool_calls} ` +
        `repairs=${r.repair_attempts} stalled=${r.stalled_repairs} files=${cut(r.changed_files_json, 200)}`
    );
}

console.log("\n############ tool_call 全部（按时间）############");
const tcs = db
    .query(`SELECT * FROM tool_call ORDER BY id`)
    .all() as any[];
console.log(`共 ${tcs.length} 条\n`);
for (const r of tcs) {
    const files = cut(r.changed_files_json, 220);
    console.log(
        `[${ts(r.started_at)}] #${r.id} ${r.tool_name} ok=${r.ok} exit=${r.exit_code} ` +
        `changed=${files === "" || files === "null" || files === "[]" ? "∅" : files}`
    );
}

console.log("\n############ completed_tool_call（只有这些是真跑完的）############");
for (const r of db.query(`SELECT * FROM completed_tool_call ORDER BY at`).all() as any[]) {
    console.log(`[${ts(r.at)}] ${r.tool_name} ok=${r.ok}  output=${cut(r.output, 260)}`);
}

console.log("\n############ process_event（起了哪些子进程）############");
for (const r of db.query(`SELECT * FROM process_event ORDER BY at`).all() as any[]) {
    console.log(`[${ts(r.at)}] ${r.kind} pid=${r.pid} cmd=${cut(r.command, 120)} args=${cut(r.args_json, 200)}`);
}

console.log("\n############ event 时间线（挑非 llm 的）############");
for (const r of db
    .query(`SELECT * FROM event WHERE type NOT IN ('llm_call_planned','llm_call_completed') ORDER BY id`)
    .all() as any[]) {
    console.log(`[${ts(r.at)}] ${r.type}  ${cut(r.payload_json, 620)}`);
}

console.log("\n############ tool_call_not_cached / sandbox / env 探针 ############");
for (const r of db
    .query(
        `SELECT * FROM event WHERE type IN ('tool_call_not_cached','sandbox_soft_mode','env_probe_timeout','batch_applied','run_start','run_end','outbound','inbound') ORDER BY id`
    )
    .all() as any[]) {
    console.log(`[${ts(r.at)}] ${r.type}  ${cut(r.payload_json, 700)}`);
}

db.close();
