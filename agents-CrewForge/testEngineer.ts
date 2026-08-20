// ============================================================
// testEngineer.ts —— 测试（多实例 "test1"/"test2"...）
//
//   完整逻辑移植自 _legacy-agents/testEngineer.ts，结构参照 manager.ts：
//     pair_ready → 机械预检（文件缺失直接 fail）→ LLM 契约判定（schema + 带反馈重试）
//     → 通过：task_passed 给维护；失败：revision 按 blame 发回对应开发返工
//
//   判定轮次上限：同一对同一阶段 ≥3 次未过 → 放弃（上报维护 + 通知合并器停止配对）。
//   计数按 阶段:pairId 键控（任务 id 每阶段从 T1 重新编号，跨阶段不得累加）。
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SystemMessage } from "@langchain/core/messages";
import { BaseAgent } from "./BaseAgent";
import { roles, type TransferStation } from "./Hub";
import { initModels } from "./models";
import { retryStructured } from "./llm";
import { type Pair, type ExecTask } from "./common";
import { nodePrompt, type Node } from "./Node";
import { currentProjectId, safePath, safeExists } from "./runEnv";


const TEST_MODEL_JSON = JSON.stringify({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    temperature: 0.2,
    thinking: false,
});

// ---------- 类型（移植自 _legacy-agents/testEngineer.ts） ----------

export interface Verdict {
    pass: boolean;
    blame: "backend" | "frontend" | "both";
    backendIssues: string[];
    frontendIssues: string[];
}

// ---------- 提示词（移植自 _legacy-agents/testEngineer.ts） ----------

export const test_prompt: string = `
# 角色
你是 CrewForge 项目的测试-契约检查 Agent。你只通过阅读任务契约和代码判断实现是否满足要求，不执行代码，也不替换开发者做设计。

## 输入
1. 后端任务（契约：method/path/入参/返回/验收标准）+ 后端产出代码
2. 前端任务（页面/交互/调用的接口/验收标准）+ 前端产出代码

## 检查顺序
1. 后端：核对 method、path、参数名与必填性、返回字段、错误处理和后端验收标准。
2. 前端：核对页面交互、表单校验、请求调用、参数组装、响应渲染和前端验收标准。
3. 集成契约：核对前端调用的 method/path、请求字段和响应字段是否与后端完全一致。
4. 每个问题都要引用可定位的实际行为，说明期望和实际；没有证据的问题不要提出。

## 输出
只输出合法 JSON，不要 Markdown、解释或额外字段：
{ "pass": true/false, "blame": "backend"|"frontend"|"both", "backendIssues": ["具体问题"], "frontendIssues": ["具体问题"] }

## 归责
结论必须明确到一侧或两侧：
- 谁错了就归谁：只有后端问题→"backend"；只有前端问题→"frontend"；两边都错→"both"
- blame 必须和 issues 自洽：blame="backend" 则 backendIssues 非空、frontendIssues 为空；"both" 则两边都非空
- 匹配问题（前后端对不上）归入出错的那一侧，blame 跟着那一侧走
- pass=true 时 issues 留空数组，blame 填 "backend" 占位（调用方只看 pass）
- pass=false 时，每条 issue 写清楚位置、期望行为和实际行为；问题应足够具体，使开发 Agent 可以直接修改。
`;

// ---------- 结构化 schema ----------

const verdictSchema = z.object({
    pass: z.boolean(),
    blame: z.enum(["backend", "frontend", "both"]),
    backendIssues: z.array(z.string()),
    frontendIssues: z.array(z.string()),
});

// ---------- 工具：读任务产出文件 ----------

function readTaskFiles(t: ExecTask): { filePath: string; content: string }[] {
    return t.files.map(fp => {
        const full = safePath(currentProjectId()!, fp); 
        if (!fs.existsSync(full)) return { filePath: fp, content: "（文件缺失：未产出）" };
        return { filePath: fp, content: fs.readFileSync(full, "utf-8") };
    });
}

// ============================================================
// TestEngineer —— 测试（固定类，消息驱动）
// ============================================================

export class TestEngineer extends BaseAgent {
    private readonly judgements = new Map<string, number>();
    /** 判定提示词（节点「测试判定」优先，空回退内置默认） */
    private readonly judgePrompt: string;

    constructor(name: string, station: TransferStation, nodes: Node[] = []) {
        super(name, roles.testEngineer, station);
        this.judgePrompt = nodePrompt(nodes, "测试判定", test_prompt);
        this.on("pair_ready", { fromNames: ["merger"] }, ({ data }) => {
            void this.judge(data.pair as Pair, data.phase as number);
        });
    }

    private async judge(pair: Pair, phase: number): Promise<void> {
        const pairKey = pair.back.id;
        const label = `${pairKey}${pair.front ? `+${pair.front.id}` : ""} ${pair.back.method} ${pair.back.path}`;
        console.log(`[${this.name}] 收到接口对：${label}`);

        // 1. 机械预检：文件缺失直接 fail（省 LLM 调用；归责按缺哪侧定）
        const missingBack = pair.back.files.filter(fp => !safeExists(currentProjectId()!, fp));
        const missingFront = pair.front ? pair.front.files.filter(fp => !safeExists(currentProjectId()!, fp)) : [];
        if (missingBack.length > 0 || missingFront.length > 0) {
            const blame: "backend" | "frontend" | "both" =
                missingBack.length > 0 && missingFront.length > 0 ? "both"
                    : missingBack.length > 0 ? "backend" : "frontend";
            await this.fail(pair, phase, pairKey, blame,
                missingBack.map(fp => `文件未产出：${fp}`),
                missingFront.map(fp => `文件未产出：${fp}`),
                label);
            return;
        }

        // 2. LLM 契约判定（失败带反馈重试；LLM 调用失败按 fail 处理，不崩流水线）
        const backFiles = readTaskFiles(pair.back);
        const frontFiles = pair.front ? readTaskFiles(pair.front) : [];
        let verdict: Verdict;
        try {
            verdict = await retryStructured<Verdict>(
                `测试判定 ${pairKey}`,
                async (feedback, sig) => {
                    const model = initModels(TEST_MODEL_JSON);
                    const result = await model
                        .withStructuredOutput(verdictSchema, { method: "jsonMode", name: "extract_verdict" })
                        .invoke([
                            new SystemMessage(
                                this.judgePrompt +
                                `\n\n## 后端任务（契约）\n${JSON.stringify(pair.back, null, 2)}` +
                                `\n\n## 后端产出代码\n${backFiles.map(f => `--- ${f.filePath} ---\n${f.content}`).join("\n")}` +
                                (pair.front
                                    ? `\n\n## 前端任务（契约）\n${JSON.stringify(pair.front, null, 2)}` +
                                      `\n\n## 前端产出代码\n${frontFiles.map(f => `--- ${f.filePath} ---\n${f.content}`).join("\n")}`
                                    : "") +
                                feedback
                            ),
                        ], { signal: sig });
                    return result as Verdict;
                },
            );
        } catch (error) {
            // LLM 失败无法归责，保守按 both（文案已写明是调用失败而非代码错误）
            verdict = { pass: false, blame: "both", backendIssues: [`LLM 调用失败：${(error as Error).message.slice(0, 100)}`], frontendIssues: [] };
        }

        if (verdict.pass) {
            this.send("maintainer", { type: "task_passed", phase, pair });
            console.log(`[${this.name}] 发送到维护：${label} 通过`);
            return;
        }
        await this.fail(pair, phase, pairKey, verdict.blame, verdict.backendIssues, verdict.frontendIssues, label);
    }

    /** 判失败：按 阶段:pairId 计数；升级式修复（3 次回炉架构师 / 6 次真放弃），否则 revision 发回对应开发 */
    private async fail(
        pair: Pair, phase: number, pairKey: string,
        blame: Verdict["blame"], backendIssues: string[], frontendIssues: string[], label: string,
    ): Promise<void> {
        const countKey = `${phase}:${pairKey}`;
        const count = (this.judgements.get(countKey) ?? 0) + 1;
        this.judgements.set(countKey, count);

        // count=1,2   → 打回开发返工（下方分支）
        // count=3     → 回炉架构师：附需求 + 测试问题，要求优化重新拆分前后端
        // count=4,5   → 重设计后的新任务继续返工
        // count=6     → 真放弃（上报维护 + 通知合并器）
        if (count % 3 === 0 && count / 3 === 1) {
            this.send("architect", { type: "task_rejected", phase, pair, issues: [...backendIssues, ...frontendIssues] });
            console.log(`[${this.name}] 提示：${label} 判定 3 次未过，回炉架构师重新拆分（附 ${backendIssues.length + frontendIssues.length} 条问题）`);
            return;
        }
        if (count % 3 === 0 && count / 3 === 2) {
            // 真放弃：原因（最近一次判定问题）+ 任务概要一起上报，不再静默
            const issues = [...backendIssues, ...frontendIssues];
            const taskInfo = { id: pairKey, method: pair.back.method, path: pair.back.path };
            this.send("maintainer", { type: "task_failed", phase, pairId: pairKey, issues, task: taskInfo, attempts: count });
            this.send("merger", { type: "task_failed", pairId: pairKey });
            console.log(`[${this.name}] 提示：${label} 判定 ${count} 次仍未通过，放弃并上报维护`);
            issues.forEach(i => console.log(`   放弃原因：${i}`));
            return;
        }

        const blameText = blame === "both" ? "前后端都错" : blame === "backend" ? "后端错" : "前端错";
        console.log(`[${this.name}]：${label} 未通过（${blameText}，第 ${count} 次判定）`);
        if (blame === "backend" || blame === "both") {
            const target = this.station.pickLeastBusy(roles.backendEngineer);
            if (target) {
                this.send(target, { type: "revision", task: pair.back, issues: backendIssues });
                backendIssues.forEach(i => console.log(`   后端：${i}`));
            } else {
                console.log(`提示：没有后端开发注册，返工发送失败：${pair.back.id}`);
            }
        }
        if (blame === "frontend" || blame === "both") {
            if (pair.front) {
                const target = this.station.pickLeastBusy(roles.frontendEngineer);
                if (target) {
                    this.send(target, { type: "revision", task: pair.front, issues: frontendIssues });
                    frontendIssues.forEach(i => console.log(`   前端：${i}`));
                } else {
                    console.log(`提示：没有前端开发注册，返工发送失败：${pair.front.id}`);
                }
            }
        }
    }
}
