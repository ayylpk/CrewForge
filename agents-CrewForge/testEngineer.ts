// ============================================================
// testEngineer.ts —— 测试（多实例 "test1"/"test2"...）· T6 强化版（9/8）
//
//   pair_ready → 机械预检（文件缺失） → **机械三查（T6 新增，零 LLM）**：
//     ① 编译复核（T1 checkFile 同引擎复用——纸审再也糊弄不过编译级事故）
//     ② 硬编码色扫描（契约铁律「≤5 处」的机械化）
//     ③ 渲染审（renderGate：vite+headless Edge 真开页面，白屏当场毙+截图存 _shots/）
//   任一机械项红 → 直接判 fail 进返工链（不烧 LLM，同"文件缺失"预检姿势）；
//   全绿 → LLM 按六项硬清单纸审（机器已做的不重复劳动，但保留加码权）→ 一致性强制：
//   checks 里有 fail 而 pass=true → 机器改判。判定报告落 runs/pN/_test-report/（证据留档）。
//
//   判定轮次上限不变：≥3 次回炉架构师、≥6 真放弃（护栏没动——T6 只加眼睛不加额度）。
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
import { currentProjectId, safePath, safeExists, projectDir } from "./runEnv";
import { contractPromptBlock, loadContracts } from "./contracts";
import { buildKnown, checkFile } from "./checkers";
import { renderCheckFrontend, type RenderOutcome } from "./renderGate";

const TEST_MODEL_JSON = JSON.stringify({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    temperature: 0.2,
    thinking: false,
});

// ---------- 类型 ----------

export interface Verdict {
    pass: boolean;
    blame: "backend" | "frontend" | "both";
    backendIssues: string[];
    frontendIssues: string[];
}

/** 清单条目（LLM 纸审六项 + 机器三项同构合并，全量进测试报告） */
export interface CheckItem {
    item: string;
    verdict: "pass" | "fail" | "skip";
    evidence: string;
}

/** LLM 必须逐项交代的六件事（缺项机器补记 skip——"清单化"不靠模型自觉） */
export const CHECKLIST_ITEMS = ["路由指向存在", "import 可解析", "三态覆盖", "契约遵从", "接口联通", "验收落实"] as const;

// ---------- 提示词（T6 硬清单版） ----------

export const test_prompt: string = `
# 角色
你是 CrewForge 项目的测试-清单判定 Agent。你只通过阅读任务契约和代码判断实现是否满足要求，不执行代码，也不替开发者做设计。

## 输入
1. 后端任务（method/path/入参/返回/验收标准）+ 后端产出代码
2. 前端任务（页面/交互/调用的接口/验收标准）+ 前端产出代码
3. 项目契约（文件归属/路由登记/视觉 token）+ 机器证据（编译/色值/渲染已由机械完成并通过）

## 六项硬清单（逐项给 verdict，不许合并、不许省略；evidence 必须引用文件与具体行为）
1. 路由指向存在——router 的每个 component 路径可在 files/契约页面清单里对上真实文件。
2. import 可解析——本地 import 的目标文件存在且导出对应名字（跨任务引用的组件/工具不悬空）。
3. 三态覆盖——页面至少具备空态与错误态处理（loading 加分不强制；只有"一把梭渲染"=fail）。
4. 契约遵从——文件归属/路由登记/共享模块复用符合契约：没重写别人的 router/main/request，没重复造轮子，颜色走 --td-* 变量。
5. 接口联通——前端调用的 method/path/请求字段/响应字段与后端一字不差（字段改名、漏包 code/data 都算 fail）。
6. 验收落实——后端与前端 acceptance 逐条对证；给不出证据的条目按 fail 报。

## 与机器证据的关系
编译级错误、硬编码色超限、渲染白屏已由机械预检处理（到你手里说明机器全绿）。
你不得用纸审推翻机器结论；但你看到机器查不到的问题（逻辑矛盾/契约违背/字段错位），必须判 fail——宁可错杀一次返工，不可放过一个假通过。

## 输出
只输出合法 JSON，不要 Markdown、解释或额外字段：
{
  "pass": true/false,
  "blame": "backend"|"frontend"|"both",
  "backendIssues": ["具体问题：位置+期望+实际"],
  "frontendIssues": ["具体问题：位置+期望+实际"],
  "checks": [ { "item": "六项之一（原样复制）", "verdict": "pass|fail|skip", "evidence": "引用性证据" } ]
}

## 归责
- 谁错了归谁：只后端问题→"backend"；只前端→"frontend"；两边→"both"；匹配问题归出错侧。
- blame 与 issues 自洽："backend" 则 backendIssues 非空且 frontendIssues 空；"both" 两边非空。
- pass=true 时 issues 留空数组、blame 填 "backend" 占位、checks 六项全 pass。
- pass=false 时每条 issue 写清位置/期望/实际，具体到开发 Agent 可直接修改。
`;

// ---------- 结构化 schema ----------

const verdictSchema = z.object({
    pass: z.boolean(),
    blame: z.enum(["backend", "frontend", "both"]),
    backendIssues: z.array(z.string()),
    frontendIssues: z.array(z.string()),
    checks: z.array(z.object({
        item: z.string(),
        verdict: z.enum(["pass", "fail", "skip"]),
        evidence: z.string(),
    })).optional(),
});

// ---------- 机械项（导出供 render-smoke 狗考） ----------

/** 契约铁律「硬编码色 ≤5」机械化：数 .vue/.css 里的 hex 色值（td-theme.css 是 token 本体，豁免） */
export function scanHardcodedHex(files: { filePath: string; content: string }[]): CheckItem {
    let count = 0;
    const where = new Set<string>();
    for (const f of files) {
        if (!/\.(vue|css|scss)$/i.test(f.filePath)) continue;
        if (/td-theme\.css$/i.test(f.filePath)) continue;
        for (const line of f.content.split(/\r?\n/)) {
            if (line.includes("--td-")) continue;   // 变量定义/引用行不算硬编码
            const hits = line.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g);
            if (hits) { count += hits.length; where.add(f.filePath); }
        }
    }
    const evidence = count > 5
        ? `发现 ${count} 处硬编码色值（上限 5）：${[...where].join("、")}`
        : `硬编码色值 ${count} 处（≤5 合规）`;
    return { item: "机械-硬编码色扫描", verdict: count > 5 ? "fail" : "pass", evidence };
}

/** 清单一致性强制（代码兜底非 prompt 祈祷）：checks 有 fail 而 pass=true → 改判；六项缺位机器补记 */
export function enforceChecklistConsistency(verdict: Verdict, llmChecks: CheckItem[]): { verdict: Verdict; checks: CheckItem[] } {
    const merged = [...llmChecks];
    for (const name of CHECKLIST_ITEMS) {
        if (!merged.some(c => c.item === name)) {
            merged.push({ item: name, verdict: "skip", evidence: "模型未输出该项（T6 清单强制补记）" });
        }
    }
    const out = { ...verdict };
    if (!verdict.pass) return { verdict: out, checks: merged };
    const failed = merged.filter(c => c.verdict === "fail");
    if (failed.length > 0) {
        const issue = `清单存在 fail 项但模型报 pass（机器改判）：${failed.map(f => `${f.item}——${f.evidence.slice(0, 100)}`).join("；")}`;
        out.pass = false;
        // fail 项没给归责侧的，两边都打回——宁可多返工一轮，不放过假通过
        out.blame = "both";
        out.backendIssues = [...verdict.backendIssues, issue];
        out.frontendIssues = [...verdict.frontendIssues, issue];
    }
    return { verdict: out, checks: merged };
}

/** 测试报告 md（留档 runs/pN/_test-report/，看板回显归阶段 6） */
export function renderTestReport(label: string, phase: number, verdict: Verdict, checks: CheckItem[], mech: CheckItem[]): string {
    const all = [...mech, ...checks];
    return [
        `# 测试报告 ${label}（阶段 ${phase}）`,
        `- 结论：${verdict.pass ? "通过" : "未通过"}｜归责：${verdict.blame}`,
        ...verdict.backendIssues.map(i => `- 后端：${i}`),
        ...verdict.frontendIssues.map(i => `- 前端：${i}`),
        "",
        "## 清单逐项",
        ...all.map(c => `- [${c.verdict === "pass" ? "x" : c.verdict === "fail" ? " " : "~"}] ${c.item}：${c.evidence}`),
        "",
    ].join("\n");
}

// ---------- 工具：读任务产出文件（T6 输入纪律：单文件截 20k，防上下文炸误判 both——§5 P4 并入本卡） ----------

function readTaskFiles(t: ExecTask): { filePath: string; content: string }[] {
    return t.files.map(fp => {
        const full = safePath(currentProjectId()!, fp);
        if (!fs.existsSync(full)) return { filePath: fp, content: "（文件缺失：未产出）" };
        const raw = fs.readFileSync(full, "utf-8");
        return { filePath: fp, content: raw.length > 20_000 ? raw.slice(0, 20_000) + "\n…（超长截断，全文见产物树）" : raw };
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
                label, [{ item: "机械-文件存在", verdict: "fail", evidence: "存在缺件" }]);
            return;
        }

        const backFiles = readTaskFiles(pair.back);
        const frontFiles = pair.front ? readTaskFiles(pair.front) : [];
        const pid = currentProjectId();

        // 2. T6 机械三查（零 LLM）：编译复核 / 硬编码色 / 渲染审。任一红=直接判负进返工链（不吃纸审名额之外——计数护栏原样）
        const mech: CheckItem[] = [];
        const mechIssuesBack: string[] = [];
        const mechIssuesFront: string[] = [];

        const compileKnown = buildKnown(pid != null ? projectDir(pid) : null,
            new Map([...backFiles, ...frontFiles].map(f => [f.filePath, f.content])), []);
        const redFiles: string[] = [];
        for (const f of [...backFiles, ...frontFiles]) {
            const problems = await checkFile(f.filePath, f.content, compileKnown);
            if (problems.length > 0) {
                redFiles.push(`${f.filePath}：${problems.join("；").slice(0, 200)}`);
                (pair.back.files.includes(f.filePath) ? mechIssuesBack : mechIssuesFront).push(`编译未过 ${f.filePath}：${problems.join("；").slice(0, 200)}`);
            }
        }
        mech.push({ item: "机械-编译复核", verdict: redFiles.length ? "fail" : "pass", evidence: redFiles.length ? redFiles.join(" ｜ ") : "全部文件过编译（T1 引擎同规格）" });

        if (frontFiles.length > 0) {
            const hex = scanHardcodedHex(frontFiles);
            mech.push(hex);
            if (hex.verdict === "fail") mechIssuesFront.push(hex.evidence);
        }

        if (pid != null && pair.front && frontFiles.some(f => /\.(vue|html|js|ts)$/i.test(f.filePath))) {
            const render: RenderOutcome = await renderCheckFrontend(pid, `${phase}-${pairKey}`);
            mech.push({
                item: "机械-渲染审",
                verdict: render.status === "skip" ? "skip" : render.status === "pass" ? "pass" : "fail",
                evidence: render.reason ?? "渲染审完成",
            });
            if (render.status === "fail") mechIssuesFront.push(`渲染白屏/空 DOM（${render.elCount ?? 0} 元素/${render.textLen ?? 0} 字）${render.shot ? `，截图 ${render.shot}` : ""}`);
        }

        if (mechIssuesBack.length > 0 || mechIssuesFront.length > 0) {
            const blame: Verdict["blame"] = mechIssuesBack.length > 0 && mechIssuesFront.length > 0 ? "both" : mechIssuesBack.length > 0 ? "backend" : "frontend";
            console.log(`[${this.name}] ${label} 机械三查拦截，不烧 LLM 直接判负`);
            await this.fail(pair, phase, pairKey, blame, mechIssuesBack, mechIssuesFront, label, mech);
            return;
        }

        // 3. LLM 六项硬清单纸审（失败带反馈重试；LLM 调用失败按 fail 处理，不崩流水线）
        const contract = contractPromptBlock(await loadContracts());   // T2：判定的"全局真相"参照
        const mechEvidence = `\n\n## 机器证据（已完成并通过，你不必重复核对）\n${mech.map(c => `- ${c.item}：${c.evidence}`).join("\n")}`;
        let verdict: Verdict;
        let checks: CheckItem[];
        try {
            const raw = await retryStructured<z.infer<typeof verdictSchema>>(
                `测试判定 ${pairKey}`,
                async (feedback, sig) => {
                    const model = initModels(TEST_MODEL_JSON, "test");
                    const result = await model
                        .withStructuredOutput(verdictSchema, { method: "jsonMode", name: "extract_verdict" })
                        .invoke([
                            new SystemMessage(
                                this.judgePrompt +
                                contract +
                                mechEvidence +
                                `\n\n## 后端任务（契约）\n${JSON.stringify(pair.back, null, 2)}` +
                                `\n\n## 后端产出代码\n${backFiles.map(f => `--- ${f.filePath} ---\n${f.content}`).join("\n")}` +
                                (pair.front
                                    ? `\n\n## 前端任务（契约）\n${JSON.stringify(pair.front, null, 2)}` +
                                      `\n\n## 前端产出代码\n${frontFiles.map(f => `--- ${f.filePath} ---\n${f.content}`).join("\n")}`
                                    : "") +
                                feedback
                            ),
                        ], { signal: sig });
                    return result;
                },
            );
            const forced = enforceChecklistConsistency(
                { pass: raw.pass, blame: raw.blame, backendIssues: raw.backendIssues, frontendIssues: raw.frontendIssues },
                raw.checks ?? [],
            );
            verdict = forced.verdict;
            checks = forced.checks;
        } catch (error) {
            // LLM 失败无法归责，保守按 both（文案已写明是调用失败而非代码错误）
            verdict = { pass: false, blame: "both", backendIssues: [`LLM 调用失败：${(error as Error).message.slice(0, 100)}`], frontendIssues: [] };
            checks = [{ item: "机械-判定兜底", verdict: "skip", evidence: "LLM 失败，机器项全绿仍按 both 打回（保守）" }];
        }

        // 4. 判定报告留档（fs 直写 _test-report/，不进 sys_project_file——报告是元数据不是产物）
        if (pid != null) {
            try {
                const dir = path.join(projectDir(pid), "_test-report");
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(path.join(dir, `${phase}-${pairKey}.md`),
                    renderTestReport(label, phase, verdict, checks, mech), "utf-8");
            } catch (e) { console.warn(`[${this.name}] 测试报告落盘失败（不拦判定）:`, (e as Error).message); }
        }

        if (verdict.pass) {
            this.send("maintainer", { type: "task_passed", phase, pair });
            console.log(`[${this.name}] 发送到维护：${label} 通过（机器三查+六项清单全绿${mech.some(c => c.verdict === "skip") ? "，含 skip 项见报告" : ""}）`);
            return;
        }
        await this.fail(pair, phase, pairKey, verdict.blame, verdict.backendIssues, verdict.frontendIssues, label, [...mech, ...checks]);
    }

    /** 判失败：按 阶段:pairId 计数；升级式修复（3 次回炉架构师 / 6 次真放弃），否则 revision 发回对应开发 */
    private async fail(
        pair: Pair, phase: number, pairKey: string,
        blame: Verdict["blame"], backendIssues: string[], frontendIssues: string[], label: string,
        checks: CheckItem[] = [],
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
        checks.filter(c => c.verdict === "fail").forEach(c => console.log(`   清单红项：${c.item} —— ${c.evidence.slice(0, 120)}`));
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
