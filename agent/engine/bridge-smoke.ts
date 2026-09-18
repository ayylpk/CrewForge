// ============================================================
// bridge-smoke.ts —— sys_task 桥原语冒烟（阶段 1 验收，不耗 LLM）
//   用法：bun run bridge-smoke.ts（跑完自动清理测试数据）
//   验证面：ensureTasksForPhase 幂等 / ext 反查 / doing·done·failed 旁路写 / 无行静默
// ============================================================
import { ensureTasksForPhase, getTaskByExt, updateStatusByExt, getTasksByStatus } from "./task";
import type { ExecTask } from "./common";

const TEST_PID = 900001;   // 专用测试项目 id（900000 段不撞真项目，收尾物理删）

const pairTasks: ExecTask[] = [
    { id: "T1", layer: "backend", method: "POST", path: "/api/auth/login", files: ["src/a.ts"],
      title: "登录接口 POST /api/auth/login：验证码校验", description: "模块：认证\n入参：username(string)", parameters: [], acceptance: "能按契约返回" },
    { id: "T1-F", layer: "frontend", method: "", path: "", files: ["src/b.vue"],
      title: "登录页：表单+提交", description: "页面：登录", parameters: [], acceptance: "能按契约返回" },
];

async function cleanup() {
    const mysql = (await import("mysql2/promise")).default;
    const conn = await mysql.createConnection({
        host: "localhost", user: "root", password: process.env.DB_PASSWORD ?? "", database: "crewforge",
    });
    await conn.query("DELETE FROM sys_task WHERE project_id = ?", [TEST_PID]);
    await conn.end();
}

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
    console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  → " + detail : ""}`);
    if (!ok) failed++;
}

try {
    // 1. 幂等登记：两次 ensure 只落 2 行
    await ensureTasksForPhase(pairTasks, TEST_PID, 1);
    await ensureTasksForPhase(pairTasks, TEST_PID, 1);
    const rows = await getTasksByStatus(TEST_PID, "todo");
    check("ensureTasksForPhase 幂等（两次=2行）", rows.length === 2, `实际 ${rows.length} 行`);

    // 2. F6 映射：前端任务 depends_on=["T1"]（JSON 列，mysql2 解析为数组）；后端 null
    const front = await getTaskByExt(TEST_PID, "T1-F");
    const back = await getTaskByExt(TEST_PID, "T1");
    check("前端任务 depends_on=[\"T1\"]", JSON.stringify(front?.depends_on) === '["T1"]', `实际 ${JSON.stringify(front?.depends_on)}`);
    check("后端任务 depends_on=null", back?.depends_on == null);
    check("sort_order=阶段*1000+序", back?.sort_order === 1000 && front?.sort_order === 1001, `${back?.sort_order}/${front?.sort_order}`);
    check("assignee 中文化", back?.assignee === "后端开发" && front?.assignee === "前端开发", `${back?.assignee}/${front?.assignee}`);

    // 3. 旁路状态写：doing → done → failed(带 error_msg)
    await updateStatusByExt(TEST_PID, "T1", "doing");
    check("doing 落库", (await getTaskByExt(TEST_PID, "T1"))?.status === "doing");
    await updateStatusByExt(TEST_PID, "T1", "failed", "登录返回字段缺 token");
    const fail = await getTaskByExt(TEST_PID, "T1");
    check("failed + error_msg", fail?.status === "failed" && (fail?.error_msg ?? "").includes("token"));
    await updateStatusByExt(TEST_PID, "T1", "done");
    check("failed→done 翻正", (await getTaskByExt(TEST_PID, "T1"))?.status === "done");

    // 4. 无行静默（桥上线前的老 ext 不打爆流水线）
    await updateStatusByExt(TEST_PID, "T99-不存在", "doing");
    check("无行静默不抛", true);

    // 5. ext 跨阶段取最新行
    await ensureTasksForPhase([{ ...pairTasks[0]!, id: "T1" }], TEST_PID, 2);   // 阶段2 同名 ext
    const latest = await getTaskByExt(TEST_PID, "T1");
    check("ext 反查取最新行(阶段2)", latest?.phase_id === 2, `phase_id=${latest?.phase_id}`);

    // 6. 返工消费查询形状（architect.bridgeTasks 依赖：todo + retry_count>0）——只 bump T1 单行
    await updateStatusByExt(TEST_PID, "T1", "todo");
    const t1 = await getTaskByExt(TEST_PID, "T1");
    const mysql = (await import("mysql2/promise")).default;
    const conn = await mysql.createConnection({ host: "localhost", user: "root", password: process.env.DB_PASSWORD ?? "", database: "crewforge" });
    await conn.query("UPDATE sys_task SET retry_count = retry_count + 1 WHERE id = ?", [t1!.id]);
    await conn.end();
    const rework = (await getTasksByStatus(TEST_PID, "todo")).filter(t => (t.retry_count ?? 0) > 0);
    check("返工消费可命中(仅T1)", rework.length === 1 && rework[0]?.task_id_ext === "T1", `命中 ${rework.length}`);
} finally {
    await cleanup();
    console.log(failed === 0 ? "\n全部通过（测试数据已清理）" : `\n${failed} 项失败（测试数据已清理）`);
    process.exit(failed === 0 ? 0 : 1);
}
