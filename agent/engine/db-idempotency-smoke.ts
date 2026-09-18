import fs from "node:fs";

const nodeSource = fs.readFileSync(new URL("./Node.ts", import.meta.url), "utf-8");
const taskSource = fs.readFileSync(new URL("./task.ts", import.meta.url), "utf-8");
const schema = fs.readFileSync(new URL("../backed-CrewForge/sql/schema.sql", import.meta.url), "utf-8");
const checks: [string, boolean][] = [
  ["project files use atomic upsert", /INSERT INTO sys_project_file[\s\S]*ON DUPLICATE KEY UPDATE/.test(nodeSource)],
  ["tasks use atomic upsert", /INSERT INTO sys_task[\s\S]*ON DUPLICATE KEY UPDATE/.test(taskSource)],
  ["task idempotency index exists", /UNIQUE KEY `uk_project_phase_task_ext` \(`project_id`,`phase_id`,`task_id_ext`\)/.test(schema)],
];
let failed = 0;
for (const [name, ok] of checks) { console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) failed++; }
console.log(`DB idempotency smoke: ${checks.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
