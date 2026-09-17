// ============================================================
// completion-smoke.ts —— 阶段 1 提交 1 自测（零 LLM 零网络）
//
//   ① decideProjectStatus 六条硬规则（0 任务 / 0 产物 / 有 failed / skipped_unverified /
//      gate=done 但未 verified / 全满足）
//   ② countArtifacts：只数产品文件（排除 node_modules / _verify / dist）
//   ③ retryStructuredResult：失败是返回值；3 次上限；category 分类；第二次**换策略**（缩小输出）
//   ④ retryStructured：到上限抛类型化 StructuredOutputFailure（不是裸异常）
//   ⑤ GraphFactory llm 节点接线：模型解析失败也走有界重试 → StructuredOutputFailure（不再裸抛）
//
//   跑法：bun run engine/run/completion-smoke.ts
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decideProjectStatus, completionReasons, type CompletionInput } from "./state";
import { countArtifacts } from "./completion";
import { retryStructured, retryStructuredResult, StructuredOutputFailure, classifyStructuredError } from "../../llm";
import { createNodeFromRow } from "../../GraphFactory";
import type { Node } from "../../Node";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string): void {
    if (cond) { pass++; console.log(`  ✓ ${msg}`); }
    else { fail++; console.log(`  ✗ ${msg}`); }
}

const base: CompletionInput = {
    taskCount: 4, artifactCount: 20, failedTaskCount: 0,
    finalGateStatus: "done", verified: true, requiredAssertionsPassed: true,
};

function main(): void {
    console.log("=== ① 唯一终态判据 ===");
    {
        ok(decideProjectStatus(base) === "done", "全满足 → done");
        ok(decideProjectStatus({ ...base, taskCount: 0 }) === "failed", "★ 0 任务 → failed（永不 done）");
        ok(decideProjectStatus({ ...base, artifactCount: 0 }) === "failed", "★ 0 产物 → failed（永不 done）");
        ok(decideProjectStatus({ ...base, failedTaskCount: 3 }) === "failed", "★ 有 failed 任务 → failed（s3 的 6/8 failed 病）");
        ok(decideProjectStatus({ ...base, finalGateStatus: "skipped_unverified", verified: false }) === "blocked",
            "★ skipped_unverified → blocked（不转换成 done）");
        ok(decideProjectStatus({ ...base, verified: false }) === "failed", "★ gate=done 但未 verified → failed");
        ok(decideProjectStatus({ ...base, requiredAssertionsPassed: false }) === "failed", "★ 必需断言未全过 → failed");
        ok(decideProjectStatus({ ...base, finalGateStatus: "failed", verified: false }) === "failed", "gate=failed → failed");
        const reasons = completionReasons({ ...base, failedTaskCount: 2, artifactCount: 0 });
        ok(reasons.length >= 2 && reasons.some(r => r.includes("产物")), `理由逐条可读：${reasons.length} 条`);
    }

    console.log("=== ② 产物计数（真读盘）===");
    {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cf-completion-"));
        fs.mkdirSync(path.join(tmp, "frontend", "src"), { recursive: true });
        fs.mkdirSync(path.join(tmp, "frontend", "node_modules", "vue"), { recursive: true });
        fs.mkdirSync(path.join(tmp, "_verify"), { recursive: true });
        fs.mkdirSync(path.join(tmp, "backend", "target"), { recursive: true });
        fs.writeFileSync(path.join(tmp, "frontend", "index.html"), "<html></html>");
        fs.writeFileSync(path.join(tmp, "frontend", "src", "main.ts"), "console.log(1)");
        fs.writeFileSync(path.join(tmp, "frontend", "node_modules", "vue", "index.js"), "dep");
        fs.writeFileSync(path.join(tmp, "_verify", "run-report.md"), "report");
        fs.writeFileSync(path.join(tmp, "backend", "target", "app.jar"), "jar");
        const n = countArtifacts(tmp);
        ok(n === 2, `只数产品文件：期望 2，实际 ${n}（排除 node_modules/_verify/target）`);
        ok(countArtifacts(path.join(tmp, "不存在的目录")) === 0, "不存在的目录 → 0");
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    console.log("=== ③ retryStructuredResult：失败是返回值 + 换策略 + 分类 ===");
    void (async () => {
        const feedbacks: string[] = [];
        const r = await retryStructuredResult<{ a: number }>(
            "smoke-parse",
            async (feedback) => {
                feedbacks.push(feedback);
                throw new Error('Failed to parse. Text: "{"a":1,"b":'.slice(0, 40));
            },
            { retries: 3, timeoutMs: 5000 },
        );
        ok(!r.ok, "3 次失败 → ok=false（不抛异常）");
        if (!r.ok) {
            ok(r.failure.attempts === 3, `attempts=3（实际 ${r.failure.attempts}）`);
            ok(r.failure.category === "OUTPUT_PARSE", `分类=OUTPUT_PARSE（实际 ${r.failure.category}）`);
            ok(r.failure.error.includes("Failed to parse"), "保留了错误原文");
            ok(r.failure.label === "smoke-parse", "保留了 label（可追溯是哪个节点）");
        }
        ok(feedbacks.length === 3, `调用次数=3（实际 ${feedbacks.length}）`);
        ok(feedbacks[0] === "", "第 1 次不带反馈（原 schema 重试）");
        ok(feedbacks[1]!.includes("校验失败"), "第 2 次把错误原文喂回");
        ok(feedbacks[2]!.includes("缩小输出"), "★ 第 3 次换策略＝要求缩小输出（不再无变化重试）");

        console.log("=== ④ retryStructured：类型化失败异常 ===");
        let caught: unknown = null;
        try {
            await retryStructured("smoke-throw", async () => { throw new Error("Failed to parse. x"); }, { retries: 2, timeoutMs: 5000 });
        } catch (e) { caught = e; }
        ok(caught instanceof StructuredOutputFailure, "★ 抛的是 StructuredOutputFailure（类型化，可带 category/attempts/原文）");
        const f = (caught as StructuredOutputFailure | null)?.failure;
        ok(!!f && f.attempts === 2 && f.category === "OUTPUT_PARSE", `failure 携带 attempts/category（${f?.attempts}/${f?.category}）`);

        console.log("=== ⑤ llm 节点接线：配置/解析失败也不裸抛 ===");
        {
            const row = {
                nodeName: "smokeLlmNode", nodeType: "llm", description: "", systemPrompt: "x",
                temperature: 0.3, tools: "", model: JSON.stringify({ provider: "no-such-provider" }),
                schemaKey: "", codeKey: "", output: "plan",
            } as unknown as Node;
            const node = createNodeFromRow(row);
            let e2: unknown = null;
            try { await node({}, {} as never); } catch (e) { e2 = e; }
            ok(e2 instanceof StructuredOutputFailure, "★ 模型解析失败 → StructuredOutputFailure（不再是原始 Error 冒泡到 runner）");
            const ff = (e2 as StructuredOutputFailure | null)?.failure;
            ok(!!ff && ff.category === "TOOL" && ff.attempts >= 2, `分类=TOOL 且有界重试（attempts=${ff?.attempts}）`);
        }

        console.log("=== ⑥ 分类函数 ===");
        ok(classifyStructuredError("Failed to parse. Text: ...") === "OUTPUT_PARSE", "解析错 → OUTPUT_PARSE");
        ok(classifyStructuredError("xxx 超时 300s，已取消请求") === "TIMEOUT", "超时 → TIMEOUT");
        ok(classifyStructuredError("未知 provider") === "TOOL", "其它 → TOOL");

        console.log(`\n[completion-smoke] 通过 ${pass}，失败 ${fail}`);
        if (fail > 0) process.exit(1);
    })();
}

main();
