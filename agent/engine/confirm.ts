// ============================================================
// confirm.ts —— 确认门 HTTP 问答器（阶段 3，v2 事实 F4 的正解）
//
//   现状盘点：CliQuestioner 阻塞 stdin（Java spawn 子进程里没人敲键盘）；
//   MessageQuestioner 是进程内 emit/resume——消息不出 Hub，跟 Java 零交集。
//   跨进程确认必须过库中转：sys_confirm 表 + /api/confirm/engine/** 两组端点。
//
//   ask() = 建题（幂等）→ 轮询取终局。30min 无人应答由 Java 侧 lazy 判定
//   auto_passed（默认答案=options 第一项），本端只管等——等待逻辑零超时分支，
//   服务端是唯一裁决方（确定性逻辑走代码+库，不赌两端时间同步）。
// ============================================================

import { javaBaseUrl } from "./settings";
import { CliQuestioner, type HumanQuestion, type Questioner } from "./GraphFactory";

const POLL_MS = Number(process.env.CONFIRM_POLL_MS ?? 4000);

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

/** Web 确认门问答器：问题落 sys_confirm，答案等浏览器点出来 */
export class HttpQuestioner implements Questioner {
    constructor(private projectId: number, private node = "architect") {}

    async ask(q: HumanQuestion): Promise<string> {
        const base = javaBaseUrl();
        const body = JSON.stringify({
            questionId: q.questionId,
            projectId: this.projectId,
            // HumanQuestion 生成点（uuid/pm-N）不带节点名，用前缀启发（纯展示/审计字段）
            node: q.questionId.startsWith("pm-") ? "manager" : this.node,
            question: q.prompt,
            options: q.options ?? [],
        });

        // 建题失败=审批单都递不出去，这是流程问题不是旁路——大声抛，让 runWithInteraction 的
        // 使用方（架构师图/PM 对话）把阶段错误暴露出来，绝不静默放行（确认门不是建议门）
        const askRes = await fetch(`${base}/api/confirm/engine/ask`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
        });
        const askJson = await askRes.json().catch(() => null) as { code?: number; msg?: string } | null;
        if (!askRes.ok || askJson?.code !== 1) {
            throw new Error(`确认门建题失败: HTTP ${askRes.status} ${askJson?.msg ?? ""}`);
        }

        // 轮询直到终局（answered / auto_passed）
        interface AnswerResp { status?: string; reply?: string | null }
        for (;;) {
            await sleep(POLL_MS);
            let d: AnswerResp | null = null;
            try {
                const r = await fetch(`${base}/api/confirm/engine/answer/${q.questionId}`);
                const j = (await r.json()) as { data?: AnswerResp };
                d = j?.data ?? null;
            } catch (e) {
                // Java 重启/抖动一两次不等死，下轮继续（题在库里，进程活着答案迟早回来）
                console.warn(`[confirm] 轮询异常（继续等）:`, (e as Error).message);
                continue;
            }
            if (d?.status === "answered") {
                console.log(`[confirm] ${q.questionId} 人已答：${d.reply}`);
                return d.reply ?? "";
            }
            if (d?.status === "auto_passed") {
                console.warn(`[confirm] ${q.questionId} 超时无应答，自动放行（默认答案：${d.reply}）`);
                return d.reply ?? "";
            }
            // pending：继续等
        }
    }
}

/** 提问实现三分流（code-over-tools：按环境变量机械判定，不猜语义）：
 *   AUTO_CONFIRM=1           → CLI 版（ask 内部自动答 "y"，全绿灯/演示路径，行为与阶段 2 一致）
 *   EXIT_AT_PHASE_BOUNDARY=1 → Http 版（Java 管理进程的身份标：无终端，问题必须上 Web 有人答）
 *   都没有（手工终端跑）      → CLI 版真 stdin 交互（老开发习惯保留） */
export function pickQuestioner(projectId: number): Questioner {
    if (process.env.EXIT_AT_PHASE_BOUNDARY === "1" && process.env.AUTO_CONFIRM !== "1") {
        return new HttpQuestioner(projectId);
    }
    return new CliQuestioner();
}
