// _prune-dispatch.ts —— 一次性清场脚本：从架构师派发幂等账本里剪掉指定任务前缀的键
// 跑法：bun run _prune-dispatch.ts <dispatch.db 绝对路径> <key 前缀，如 20-p1:>
import { Database } from "bun:sqlite";

const [file, prefix] = [process.argv[2]!, process.argv[3]!];
const db = new Database(file);
const before = db.query(
    "SELECT msg_key FROM seen_message WHERE msg_key LIKE ? ORDER BY msg_key",
).all(`${prefix}%`) as { msg_key: string }[];
console.log("待剪键：", before.map((r) => r.msg_key).join("\n         ") || "（无）");
const r = db.run("DELETE FROM seen_message WHERE msg_key LIKE ?", [`${prefix}%`]);
console.log(`deleted=${r.changes}`);
db.close();
