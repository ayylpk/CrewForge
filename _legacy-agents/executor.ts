import fs from "node:fs";
import { spawn } from "node:child_process";

// ============================================================
// 执行层串联（v1 演示版）：一条命令跑完整条流水线
//
//   plan.json → 架构师(architect) → 后端工程师(backendEngineer)
//   → 前端工程师(frontendEngineer) → 测试(testEngineer) → 维护(maintainer)
//
// 关键约定：
//   - 各阶段是独立脚本（Node --experimental-strip-types xxx.ts），交接物只有文件：
//     plan.json → tasks.json → workspace/（代码落盘）
//   - agent 间不通信（演示版）：测试/维护结果只输出控制台
//   - 架构师确认门：默认交互确认；AUTO_CONFIRM=1 跳过（CI/快速验证）
//   - 用法：node --experimental-strip-types executor.ts（或 AUTO_CONFIRM=1 node --experimental-strip-types executor.ts）
// ============================================================

// 子进程跑脚本（继承 stdio，env 透传——AUTO_CONFIRM 直接可用）
// 每个阶段使用同一个 Node 运行时，避免混用运行时造成行为差异。
function run(script: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--experimental-strip-types", script], {
            stdio: "inherit",
        });
        child.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${script} 失败（退出码 ${code}），流水线中止`));
        });
        child.on("error", reject);
    });
}

async function main() {
    const t0 = Date.now();
    try {
        await pipeline(t0);
    } catch (e) {
        console.error(`\n执行失败：${(e as Error).message}`);
        process.exit(1);
    }
}

async function pipeline(t0: number) {

    // 前置：plan.json（manager.ts 产出，缺失则提示）
    if (!fs.existsSync("plan.json")) {
        console.log("缺少 plan.json。请先运行 node --experimental-strip-types manager.ts 产出项目规划，再运行本串联。");
        process.exit(1);
    }
    console.log("========== CrewForge 执行层串联开工 ==========\n");

    // 阶段 1：架构师（plan.json → tasks.json，含文件清单 files）
        console.log("阶段 1/5：架构师（需求到任务拆分）");
    await run("architect.ts");
    const tasks = JSON.parse(fs.readFileSync("tasks.json", "utf-8")) as {
        id: string; layer: string; files: string[];
    }[];
    const backCount = tasks.filter(t => t.layer === "backend").length;
    const frontCount = tasks.filter(t => t.layer === "frontend").length;
    console.log(`任务 ${tasks.length} 个：后端 ${backCount}，前端 ${frontCount}\n`);

    // 阶段 2：后端工程师（写盘 workspace/）
    if (backCount > 0) {
        console.log("阶段 2/5：后端工程师（双工位流水线，写盘 workspace/）");
        await run("backendEngineer.ts");
        console.log();
    }

    // 阶段 3：前端工程师（写盘 workspace/）
    if (frontCount > 0) {
        console.log("阶段 3/5：前端工程师（双工位流水线，写盘 workspace/）");
        await run("frontendEngineer.ts");
        console.log();
    }

    // 阶段 4：测试（配对契约检查，结果只输出控制台）
    if (tasks.length > 0) {
        console.log("阶段 4/5：测试（前后端配对，LLM 模拟执行判断）");
        await run("testEngineer.ts");
        console.log();
    }

    // 阶段 5：维护（落盘确认 + 交付说明，控制台输出）
    if (tasks.length > 0) {
        console.log("阶段 5/5：维护（落盘确认 + 交付说明）");
        await run("maintainer.ts");
        console.log();
    }

    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`流水线完成，耗时 ${secs}s。`);
    console.log("产物：workspace/（代码）+ tasks.json（任务清单，含文件坐标）");
}

main();
