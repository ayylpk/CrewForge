// ============================================================
// t4-smoke.ts —— T4 功能竖切冒烟（9/8，确定性层零 LLM）
//
//   覆盖：①resolutionSchema 竖切形状（min(1) 门：空 apis/空 pages 直接拒）
//         ②buildExecTasks 狗考：一个功能=一对任务、多接口多页面聚合、
//           files 去重、契约全量自包含进两侧 description、验收机械继承、id 配对规矩不变
//         ③sliceGuard：≥3 文件收敛 2 次×420s；小任务老行为原样（3 次×300s）
//   卡面"每页面单任务生成"由 ①竖切+②files 聚合机械保证；生成层保留逐文件
//   （T1/TDesign 文件级闸门不动）——任务内文件互见 9/8 已修，等价"同上下文生成"（降级形态记录在流水账）。
//   跑法：bun run t4-smoke.ts
// ============================================================

import { resolutionSchema, buildExecTasks } from "./architect";
import { sliceGuard } from "./common";
import type { Plan } from "./common";

let pass = 0, fail = 0;
function ok(cond: boolean, label: string, extra = "") {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}

const GOOD = {
    tasks: [[
        {
            feature: "登录注册",
            apis: [
                { method: "POST", path: "/api/login", purpose: "登录", files: ["backend/app/routers/auth.py", "backend/app/schemas/auth.py"], parameters: [{ name: "username", type: "string", required: true, description: "用户名" }], response: "{code,data:{token}}" },
                { method: "POST", path: "/api/register", purpose: "注册", files: ["backend/app/routers/auth.py"], parameters: [], response: "{code,message}" },
            ],
        },
        {
            feature: "登录注册",
            pages: [
                { page: "登录页", interactions: "表单+错误提示", files: ["frontend/src/views/Login.vue"] },
                { page: "注册页", interactions: "表单+两次密码校验", files: ["frontend/src/views/Register.vue"] },
            ],
        },
    ], [
        { feature: "打卡", apis: [{ method: "POST", path: "/api/checkin", purpose: "打卡", files: ["backend/app/routers/checkin.py"], parameters: [], response: "{code}" }], },
        { feature: "打卡", pages: [{ page: "主页", interactions: "日历热力图", files: ["frontend/src/views/Home.vue"] }], },
    ]],
};

const detailed = { phase: 1, modules: [{ name: "登录注册", business: "用户登录", description: "", dataNeeds: [], points: [] }] };
const stack = {
    techniques: { middleware: [{ name: "JWT", purpose: "令牌" }], database: { type: "SQLite", why: "零运维" } },
    moduleTech: [{ module: "登录注册", backend: "FastAPI", frontend: "Vue3+TDesign" }],
};
const plan: Plan = {
    project: "习惯打卡应用", risks: [], mvp_scope: ["用户登录"],
    features: [{ name: "用户登录", description: "d", priority: "高", acceptance: "错误密码必须有明确提示" }],
    phases: [{ phase: 1, name: "地基", goal: "登录闭环", features: ["用户登录"], dependencies: [], relative_effort: "小", risk: "低" }],
};

function main() {
    console.log("=== ① schema 门 ===");
    const parsed = resolutionSchema.safeParse(GOOD);
    ok(parsed.success, "竖切形状通过", parsed.success ? "" : JSON.stringify(parsed.error.issues[0] ?? parsed.error));
    ok(!resolutionSchema.safeParse({ tasks: [[[{ feature: "f", apis: [] }, { feature: "f", pages: [{ page: "p", interactions: "", files: [] }] }]]] }).success, "空 apis 被 min(1) 拒");
    ok(!resolutionSchema.safeParse({ tasks: [[[{ feature: "f", apis: GOOD.tasks[0]?.[0]?.apis ?? [] }, { feature: "f", pages: [] }]]] }).success, "空 pages 被 min(1) 拒");

    console.log("=== ② buildExecTasks 狗考 ===");
    const tasks = buildExecTasks(parsed.data!, detailed, stack, plan);
    ok(tasks.length === 4, "两功能 → 四任务（成对）");
    const b1 = tasks[0]!, f1 = tasks[1]!, b2 = tasks[2]!, f2 = tasks[3]!;
    ok(b1.id === "T1" && f1.id === "T1-F" && b2.id === "T2" && f2.id === "T2-F", "配对 id 规矩不变（merger/maintainer 无感）");
    ok(b1.title === "功能 登录注册（2 个接口）", "多接口标题聚合", b1.title);
    ok(b1.files.join(",") === "backend/app/routers/auth.py,backend/app/schemas/auth.py", "后端 files 跨接口并集去重", b1.files.join(","));
    ok(b1.method === "POST" && b1.path === "/api/login", "method/path 带主接口（看板列可读）");
    ok(b1.description.includes("包含接口（2 个，全部必须实现）") && b1.description.includes("/api/register"), "后端 description 两组接口全在");
    ok(f1.files.length === 2 && f1.title.includes("登录页、注册页"), "前端整页归一任务（页面对象聚合）", JSON.stringify(f1.files));
    ok(f1.description.includes("【后端契约") && f1.description.includes("/api/register") && f1.description.includes("两次密码校验"), "前端 description 自包含整组契约+每页交互");
    ok(b1.acceptance === "错误密码必须有明确提示" && f1.acceptance === b1.acceptance, "验收从 plan 机械继承（pair 两侧一致）");
    ok(b1.parameters.length === 1 && b1.parameters[0]?.name === "username", "parameters 带主接口（列形状不破坏）");
    ok(b2.acceptance === "功能可正常使用", "模块对不上时验收兜底不崩", b2.acceptance);
    ok(f1.description.includes("FastAPI") === false && f1.description.includes("Vue3+TDesign"), "前端描述带前端技术、不混后端栈");

    console.log("=== ③ sliceGuard 护栏 ===");
    ok(sliceGuard(2).maxAttempt === 3 && sliceGuard(2).timeoutMs === 300_000, "接口对时代的小任务行为原样");
    ok(sliceGuard(3).maxAttempt === 2 && sliceGuard(3).timeoutMs === 600_000, "竖切≥3 文件：2 次×600s（T7a 复核后上调，卡面原值 420）");
    ok(sliceGuard(b1.files.length).maxAttempt === 3, "本例 T1 后端 2 文件<3 → 走老行为（护栏不误伤小任务）", `files=${b1.files.length}`);
    ok(sliceGuard(f1.files.length + 2).maxAttempt === 2, "≥3 文件即收敛（3 文件竖切任务）");

    console.log(`\n=== 汇总：${pass} 绿 / ${fail} 红 ===`);
    if (fail > 0) process.exit(1);
}

main();
