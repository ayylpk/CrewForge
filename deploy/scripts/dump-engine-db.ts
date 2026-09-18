/*
 * dump-engine-db.ts —— 只读 dump 引擎的状态库（SQLite），用来定位"为什么没写盘"
 * ---------------------------------------------------------------------------
 * 跑法（cwd = CrewForge）：
 *   bun run scripts/dump-engine-db.ts <某个 .db 路径> [每表打印条数]
 *
 * 只读打开，绝不写。表结构未知，所以先列结构再按"看起来像事件表"的那张打时间线。
 */
import { Database } from "bun:sqlite";

const dbPath = process.argv[2]!;
const limit = Number(process.argv[3] ?? 40);
if (!dbPath) {
    console.error("用法: bun run scripts/dump-engine-db.ts <db 路径> [条数]");
    process.exit(2);
}

const db = new Database(dbPath, { readonly: true });

const cut = (s: string, n = 500) => (s.length > n ? s.slice(0, n) + ` …[+${s.length - n}]` : s);

const tables = db
    .query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as { name: string }[];

console.log(`库: ${dbPath}`);
console.log(`表(${tables.length}): ${tables.map((t) => t.name).join(", ")}\n`);

for (const { name } of tables) {
    const cols = (db.query(`PRAGMA table_info("${name}")`).all() as { name: string; type: string }[]);
    const n = (db.query(`SELECT COUNT(*) AS c FROM "${name}"`).get() as { c: number }).c;
    console.log(`=== ${name}  (${n} 行)`);
    console.log(`    列: ${cols.map((c) => `${c.name}:${c.type}`).join(", ")}`);

    // 有 kind/type/event 这类列的话，先给个取值分布——一眼看出卡在哪个环节
    const kindCol = cols.find((c) => ["kind", "type", "event", "event_type", "name"].includes(c.name));
    if (kindCol && n > 0) {
        const dist = db
            .query(`SELECT "${kindCol.name}" AS k, COUNT(*) AS c FROM "${name}" GROUP BY 1 ORDER BY c DESC LIMIT 25`)
            .all() as { k: string; c: number }[];
        console.log(`    ${kindCol.name} 分布: ${dist.map((d) => `${d.k}=${d.c}`).join("  ")}`);
    }
    console.log("");
}

// 找"事件时间线"：优先带 payload/data/json 列的表
const evTable = tables
    .map((t) => t.name)
    .find((t) => {
        const cols = (db.query(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((c) => c.name);
        return cols.some((c) => ["payload", "data", "json", "detail", "body", "value"].includes(c));
    });

if (evTable) {
    const cols = (db.query(`PRAGMA table_info("${evTable}")`).all() as { name: string }[]).map((c) => c.name);
    const payloadCol = cols.find((c) => ["payload", "data", "json", "detail", "body", "value"].includes(c))!;
    console.log(`\n########## ${evTable} 最近 ${limit} 条（按 rowid 倒序）##########`);
    const rows = db
        .query(`SELECT * FROM "${evTable}" ORDER BY rowid DESC LIMIT ${limit}`)
        .all() as Record<string, unknown>[];
    for (const r of rows.reverse()) {
        const head = cols
            .filter((c) => c !== payloadCol)
            .map((c) => `${c}=${String((r as any)[c])}`)
            .join(" ");
        console.log(`\n--- ${head}`);
        console.log(`    ${cut(String((r as any)[payloadCol]))}`);
    }
} else {
    console.log("\n(没找到带 payload/data/json 列的事件表)");
}

db.close();
