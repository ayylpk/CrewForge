// ============================================================
// ledger.ts —— 失败账本（零 LLM）
//
//   解决两个具体浪费（runs/p9 实况）：
//     ① 同一处错反复修、每次都用同一种修法 —— 烧钱且不收敛
//     ② 修完没人重跑验证，靠模型自述"已修复"
//
//   机制：把失败归一成**签名**（类型 + 文件 + 去数字的消息），记录用过哪些修法。
//   同一签名 + 同一修法出现第二次 → shouldEscalate=true：禁止原地重试同类修法，
//   必须换策略（缩任务粒度 / 换修法 / 升级分流），由调用方决定怎么换。
//
//   持久化说明：当前为进程内实现；主计划 M2（Ledger/状态机）接管后落库，
//   接口不变（record/snapshot 语义已按可持久化设计）。
// ============================================================

export type FixKind = "compile_repair" | "contract_replan" | "env_recovery" | "task_shrink" | "model_regenerate";

export interface LedgerEntry {
    sig: string;
    kind: string;
    attempts: number;
    fixKinds: FixKind[];
    lastMessage: string;
}

export interface RecordOutcome {
    /** 该签名出现总次数 */
    attempts: number;
    /** ★ true = 同一签名 + 同一修法已试过，禁止原地重复，必须换策略 */
    shouldEscalate: boolean;
    reason?: string;
}

/** 消息归一：抹掉数字与空白差异（行号/列号/长度会随编辑漂移，不该影响"同一处错"的判定） */
function normMessage(message: string): string {
    return message.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 160);
}

function baseName(file: string): string {
    return (file.replace(/\\/g, "/").split("/").pop() ?? file).toLowerCase();
}

/** 一组诊断 → 签名（按文件+消息归一，排序保证稳定；与行号无关） */
export function signatureOf(kind: string, diagnostics: { file: string; message: string }[]): string {
    const parts = diagnostics
        .map(d => `${kind}|${baseName(d.file)}|${normMessage(d.message)}`)
        .filter((v, i, a) => a.indexOf(v) === i)
        .sort();
    return (parts.join(";") || `${kind}|(无诊断)`).slice(0, 600);
}

export class FailureLedger {
    private readonly entries = new Map<string, LedgerEntry>();

    /** 记一次失败 + 打算用的修法；返回是否必须升级（禁止原地重复） */
    record(sig: string, fixKind: FixKind, kind = "", message = ""): RecordOutcome {
        const hit = this.entries.get(sig);
        if (!hit) {
            this.entries.set(sig, { sig, kind, attempts: 1, fixKinds: [fixKind], lastMessage: message });
            return { attempts: 1, shouldEscalate: false };
        }
        hit.attempts += 1;
        hit.lastMessage = message || hit.lastMessage;
        const sameFixAlreadyTried = hit.fixKinds.includes(fixKind);
        if (!sameFixAlreadyTried) hit.fixKinds.push(fixKind);
        return {
            attempts: hit.attempts,
            shouldEscalate: sameFixAlreadyTried,
            reason: sameFixAlreadyTried
                ? `同一失败签名已用「${fixKind}」修过 ${hit.attempts - 1} 次，重复同类修法无益——请换策略（缩任务/换修法/升级分流）`
                : undefined,
        };
    }

    /** 只读快照（报告/落库用） */
    snapshot(): LedgerEntry[] {
        return [...this.entries.values()].map(e => ({ ...e, fixKinds: [...e.fixKinds] }));
    }

    /** 同一签名出现次数（观测用） */
    attemptsOf(sig: string): number {
        return this.entries.get(sig)?.attempts ?? 0;
    }

    size(): number { return this.entries.size; }
}
