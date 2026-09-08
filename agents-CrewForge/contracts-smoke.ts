// ============================================================
// contracts-smoke.ts —— T2 全局契约冒烟（9/8，确定性层零 LLM 零 DB）
//
//   覆盖：①assembleContracts 骨架完整（确定性段全在场：视觉 token/基约/铁律 5 条逐点名）
//         ②LLM 段缺失的降级形态（骨架照落+占位说明，发布永不因登记段崩）
//         ③contractPromptBlock 拼接与空旁路  ④loadContracts 无 pid/无库= null 不炸
//   跑法：bun run contracts-smoke.ts（publishContracts 真调 LLM 归 live 首轮）
// ============================================================

import {
    assembleContracts, contractPromptBlock, loadContracts, resetContractsCache,
    CONTRACT_LAWS, CONTRACT_API_BASE, CONTRACT_STYLE_SECTION, CONTRACTS_FILE,
} from "./contracts";
import type { Plan } from "./common";

let pass = 0, fail = 0;
function ok(cond: boolean, label: string, extra = "") {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}

const plan: Plan = {
    project: "习惯打卡应用", features: [], mvp_scope: [], risks: [],
    phases: [{ phase: 1, name: "地基", goal: "登录+打卡闭环", features: [], dependencies: [], relative_effort: "", risk: "" }],
};

async function main() {
    console.log("=== ① 骨架完整（LLM 两段正常供给） ===");
    const md = assembleContracts(1, plan, {
        pages: "- /login → frontend/src/views/Login.vue（登记任务 T1-F，router 追加责任归它）",
        shared: "- frontend/src/utils/request.ts（创建任务 T1-F，其余任务只 import 禁重写）",
    });
    ok(md.includes("项目契约（阶段 1 生成"), "标题带阶段号");
    ok(md.includes("登录+打卡闭环"), "goal 从 plan 机械抄（不劳 LLM）");
    ok(md.includes(CONTRACT_STYLE_SECTION.split("\n")[0] ?? "§"), "视觉 token 段在场");
    ok(md.includes("td-theme.css"), "视觉真相指向单一来源主题文件");
    ok(md.includes("/login") && md.includes("T1-F"), "页面清单（LLM 段）并入");
    ok(md.includes("request.ts"), "共享模块（LLM 段）并入");
    ok(md.includes(CONTRACT_API_BASE.split("\n")[0] ?? "§"), "接口基约段在场");
    for (const law of ["只有下表登记的「登记任务」可修改", "没登记的文件不许被 import", "唯一任务创建", "硬编码色值不得超过 5 处", "禁止在两个根目录"]) {
        ok(md.includes(law) && CONTRACT_LAWS.includes(law), `铁律点名：${law.slice(0, 12)}…`);
    }

    console.log("=== ② LLM 段缺失=降级不崩 ===");
    const degraded = assembleContracts(2, null, null);
    ok(degraded.includes("契约登记降级"), "pages 缺失走占位说明");
    ok(degraded.includes("（见任务清单）"), "plan=null 时 goal 兜底");
    ok(degraded.includes(CONTRACT_LAWS.slice(0, 20)), "铁律仍完整（降级只丢 LLM 段，纪律不丢）");

    console.log("=== ③ prompt 拼接与旁路 ===");
    ok(contractPromptBlock(null) === "", "无契约=空串（旁路，行为回到 T2 前）");
    const block = contractPromptBlock(md);
    ok(block.includes(CONTRACTS_FILE) && block.includes("以此为准") && block.includes("/login"), "契约全文进块");

    console.log("=== ④ 无 pid/无库读取旁路 ===");
    resetContractsCache();
    delete process.env.PROJECT_ID;
    const none = await loadContracts();
    ok(none === null, "loadContracts 无项目上下文=null 不炸");
    const again = await loadContracts();   // 60s 缓存路径
    ok(again === null, "二读走缓存仍 null（不重复抛）");

    console.log(`\n=== 汇总：${pass} 绿 / ${fail} 红 ===`);
    if (fail > 0) process.exit(1);
}

main().catch(e => { console.error("冒烟脚本自身炸了:", e); process.exit(2); });
