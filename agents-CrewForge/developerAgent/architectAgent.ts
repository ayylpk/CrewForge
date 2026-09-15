// ============================================================
// architectAgent.ts —— 自包含架构师 Agent（需求文本 → ArchitectTask）
//
// 定位（9/15 新增）：此前 developerAgent 吃的任务包全靠"人 + Claude 手写 JSON"
//   （live/runner.ts --task xxx.json）。本模块把这一步自动化：唯一输入是**项目需求
//   原文**，一次 LLM 调用直接产出 developerAgent 可直接吃的完整 ArchitectTask。
//
// 设计（用户拍板"一步出整包"）：
//   · 1 次 LLM 调用吐完整 JSON → extractJson 抠出 → 四道校验链 → 不过就把
//     **报错原文**喂回重试（≤maxAttempts）——与 graph 的 llmErrorTolerance 同哲学：
//     模型犯格式错不是死刑，有反馈环就能自愈；
//   · 校验链（从宽到严）：
//     ① assertNoAuthorityFields —— 权威字段（done/verified/exitCode…）禁入，
//        这是"权威判定不在模型侧"铁律的入口闸；
//     ② extractJson —— 围栏/叙述文字里的 JSON 都能抠（复用 realLlm 既有函数）；
//     ③ ArchitectTaskSchema.parse —— 形状校验（zod issues 摘要进反馈）；
//     ④ 业务硬闸：workItems / foundationPlan.dirs / acceptanceChecks 非空
//        —— 空包 schema 层合法但没法干活，提前拦；
//     ⑤ parseInbound 终验 —— 保证产物与 runner --task 完全同链路（runner 兼容的
//        机器证据，不是"应该兼容"）。
//   · 零依赖旧基建：不碰 BaseAgent/Hub/sys_task（旧 architect.ts 是另一条路线）；
//     LLM 通过 DeveloperLlm 接口注入（测试注 Fake，生产注 createRealLlm）。
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { extractJson } from "./realLlm";
import {
    ArchitectTaskSchema, assertNoAuthorityFields, parseInbound,
} from "./protocol";
import type { ArchitectTask } from "./protocol";
import type { DeveloperLlm } from "./graph";

const ARCHITECT_PROMPT_PATH = path.resolve(import.meta.dir, "prompts", "architect-system.md");

export interface ArchitectAgentOptions {
    /** LLM 适配器（DeveloperLlm 接口，与 developerAgent 同一形状） */
    llm: DeveloperLlm;
    /** 最大尝试次数（含首次），缺省 3 */
    maxAttempts?: number;
}

export interface DecomposeInput {
    /** 项目需求原文（唯一业务输入） */
    requirement: string;
    /** 任务包身份，缺省 "p1"/"t1" */
    projectId?: string;
    taskId?: string;
}

/** 拆解结果：任务包 + 过程观测量（测试/CLI 报告用） */
export interface DecomposeResult {
    task: ArchitectTask;
    /** 消耗的 LLM 调用次数（含被拒重试） */
    attempts: number;
    /** 每轮被拒的原因摘要（成功前那些轮）；一次成功则为空 */
    rejections: string[];
}

/**
 * 把 zod 错误压成模型可读、人也可读的摘要：
 * 每条 issue 一行"路径: 消息"，最多 12 条防爆。
 */
function zodIssuesSummary(error: unknown): string {
    const issues = (error as { issues?: { path: (string | number)[]; message: string }[] })?.issues;
    if (!Array.isArray(issues) || issues.length === 0) return String(error);
    return issues
        .slice(0, 12)
        .map((i) => `- ${i.path.length ? i.path.join(".") : "(根)"}：${i.message}`)
        .join("\n");
}

export function createArchitectAgent(o: ArchitectAgentOptions) {
    const maxAttempts = o.maxAttempts ?? 3;
    // 提示词从磁盘读（与 developerAgent 的 prompts/ 管理方式一致）；缺失 fail fast
    const system = fs.readFileSync(ARCHITECT_PROMPT_PATH, "utf-8");
    if (!system.trim()) throw new Error("architectAgent：prompts/architect-system.md 为空或不可读");

    return {
        /**
         * 需求文本 → ArchitectTask。校验不过把报错原文喂回重试，全败抛错（不静默）。
         */
        async decompose(input: DecomposeInput): Promise<DecomposeResult> {
            const requirement = input.requirement?.trim();
            if (!requirement) throw new Error("architectAgent：需求文本为空");
            const projectId = input.projectId ?? "p1";
            const taskId = input.taskId ?? "t1";

            const rejections: string[] = [];
            let feedback = "";

            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                const user = [
                    `## 项目需求\n${requirement}`,
                    `## 任务包身份\nprojectId: ${projectId}\ntaskId: ${taskId}`,
                    feedback ? `## 上一版输出被拒，必须修正\n${feedback}` : "",
                    feedback
                        ? "请根据拒绝原因修正后，重新输出**完整**的任务包 JSON（不要只输出改动部分）。"
                        : "请输出完整的任务包 JSON。",
                ].filter(Boolean).join("\n\n");

                const raw = await o.llm.next({
                    system, task: user, skill: null, history: [], tools: [],
                    // 架构师的"预算"= 剩余重试次数（批 E 预算可见性的同款用途：
                    // 让模型知道还有几次机会，而不是盲重试）
                    budget: { used: attempt - 1, total: maxAttempts },
                });

                // ① 抠 JSON（围栏/叙述都能处理；抠不出=原文交回当拒绝原因）
                // DeveloperLlm 信封拆包（9/15 实弹抓到）：realLlm 在无工具模式下返回
                // {kind:"done", note:"<模型正文>"}——这是 Developer 工具循环的完成信号
                // 形状，对架构师来说是**信封**，正文在 note 里。不拆的话 extractJson
                // 抠到的是外层信封（顶层键 kind/note），zod 必然全字段 undefined。
                const text = typeof raw === "string"
                    ? raw
                    : (raw !== null && typeof raw === "object" && typeof (raw as { note?: unknown }).note === "string"
                        ? (raw as { note: string }).note
                        : JSON.stringify(raw));
                let candidate: unknown;
                try {
                    candidate = extractJson(text);
                } catch {
                    candidate = null;
                }
                if (candidate === null || candidate === undefined) {
                    feedback = `输出里找不到合法 JSON 对象。原文开头：${text.slice(0, 300)}`;
                    rejections.push(feedback);
                    continue;
                }

                // ② 权威字段闸（铁律：done/verified/exitCode 等只能由程序产生）
                try {
                    assertNoAuthorityFields("architect 拆解", candidate);
                } catch (e) {
                    feedback = `输出包含禁止的权威字段：${(e as Error).message}`;
                    rejections.push(feedback);
                    continue;
                }

                // ③ 形状校验（ArchitectTaskSchema，zod）
                let parsed: ArchitectTask;
                try {
                    parsed = ArchitectTaskSchema.parse(candidate);
                } catch (e) {
                    feedback = `任务包形状不对（zod 校验失败）：\n${zodIssuesSummary(e)}`;
                    rejections.push(feedback);
                    continue;
                }

                // 身份字段强制覆盖（code-over-tools：projectId/taskId 是对号用的
                // 确定性管道信息，不赌模型照抄——prompt 里写了"照抄"只是减少返工，
                // 这里的覆盖才是保证；模型写错也不至于把账记串）。
                parsed.projectId = projectId;
                parsed.taskId = taskId;

                // ④ 业务硬闸：schema 合法但没法干活的空包提前拦
                const gaps: string[] = [];
                if (!parsed.foundationPlan.workItems || parsed.foundationPlan.workItems.length === 0) {
                    gaps.push("foundationPlan.workItems 不能为空（必须显式给出工作项清单，不要留给目录推导）");
                }
                if (!parsed.foundationPlan.dirs || parsed.foundationPlan.dirs.length === 0) {
                    gaps.push("foundationPlan.dirs 不能为空");
                }
                if (parsed.acceptanceChecks.length === 0) {
                    gaps.push("acceptanceChecks 不能为空（验收判据是送检依据，一条都没有=没法验收）");
                }
                if (gaps.length > 0) {
                    feedback = `任务包业务不完整：\n${gaps.map((g) => `- ${g}`).join("\n")}`;
                    rejections.push(feedback);
                    continue;
                }

                // ⑤ parseInbound 终验：与 runner --task 同链路（机器证据，不是"应该兼容"）
                const inbound = parseInbound(JSON.stringify(parsed));
                if (!inbound.ok) {
                    feedback = `任务包未通过 runner 入站校验：${inbound.error}`;
                    rejections.push(feedback);
                    continue;
                }

                return {
                    task: parsed,
                    attempts: attempt,
                    rejections,
                };
            }

            throw new Error(
                `architectAgent：拆解 ${maxAttempts} 次全部被拒。最后一次原因：\n${rejections[rejections.length - 1] ?? "(无)"}`,
            );
        },
    };
}
