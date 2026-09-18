// ============================================================
// baseline.ts —— 历史基线采集 CLI（零 LLM）
//
//   用途：对既有产物树打分，产出 eval/baseline/historical.json + 控制台表格。
//   ★ 不运行 agent 团队、不调 LLM、不生成新代码——只对**已有产物**做静态与编译校验。
//
//   跑法：bun run eval/baseline.ts             （默认 runs/p1,p2,p4,p9）
//         bun run eval/baseline.ts p9 p4       （指定）
//         RUNS_ROOT=<path> bun run eval/baseline.ts
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { collectSnapshot } from "./collect";
import { scoreSnapshot, summarizeScoreCard, type ScoreCard } from "./scorecard";

const RUNS_ROOT = process.env.RUNS_ROOT?.trim()
    || path.resolve(import.meta.dir, "..", "..", "runs");

function exists(p: string) { try { return fs.existsSync(p); } catch { return false; } }

function main(): void {
    const argv = process.argv.slice(2).filter(a => !a.startsWith("-"));
    const ids = argv.length > 0 ? argv : ["p1", "p2", "p4", "p9"];

    const cards: ScoreCard[] = [];
    const snapshots = [];
    for (const id of ids) {
        const dir = path.join(RUNS_ROOT, id);
        if (!exists(dir)) { console.log(`[baseline] 跳过 ${id}：目录不存在（${dir}）`); continue; }
        const snap = collectSnapshot(dir, id);
        const card = scoreSnapshot(snap);
        snapshots.push(snap);
        cards.push(card);
        console.log(`\n=== ${id} ===  ${summarizeScoreCard(card)}`);
        console.log(`  产物 ${snap.fileCount} 文件｜测试报告 ${snap.testReports}｜任务证据 ${snap.taskEvidence}｜契约 ${snap.hasContracts ? "有" : "无"}｜index.html 入口 ${snap.indexHtmlScript ?? "n/a"}`);
        console.log(`  Java: ${snap.java.summary}`);
        for (const it of card.items) {
            const mark = it.ok === true ? "✓" : it.ok === false ? "✗" : "~";
            console.log(`  ${mark} ${it.key.padEnd(28)} ${it.detail}`);
        }
    }

    const outDir = path.join(import.meta.dir, "baseline");
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, "historical.json");
    fs.writeFileSync(outFile, JSON.stringify({
        generatedAt: new Date().toISOString(),
        runsRoot: RUNS_ROOT,
        note: "历史基线：由既有产物树静态采集（非可复现的端到端基线）。未运行 agent 团队、未调用 LLM。",
        cards,
        snapshots: snapshots.map(s => ({
            ...s,
            // report 内含逐条诊断，体积可控，保留以便追溯
        })),
    }, null, 2), "utf-8");
    console.log(`\n[baseline] 已写出 ${outFile}`);
}

main();
