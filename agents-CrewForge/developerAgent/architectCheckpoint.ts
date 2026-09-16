import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ArchitectBatchSchema, ArchitectTaskSchema } from "./protocol";
import type { ArchitectBatch, ArchitectTask, WorkItem } from "./protocol";

/**
 * 架构师拆解的续跑档案：蓝图 + 已完成的批次前缀。
 * 语义上它是一份**蓝图前缀**的证明——batches 必须是 blueprint.foundationPlan.workItems
 * 的顺序前缀，跳批/重批/超批在这里就抛，不留给下游的 assembleTask 去发现。
 */
export interface ArchitectCheckpoint {
    version: 1;
    requirementHash: string;
    projectId: string;
    taskId: string;
    blueprint: ArchitectTask;
    batches: ArchitectBatch[];
    updatedAt: string;
}

/**
 * 批次中间产物文件名。itemId 是模型给的自由文本（Schema 只管非空），
 * 直接拼进路径会让 `a/b`、`C:x` 这类 id 把文件写到 parts 目录外面去——
 * 落盘失败事小，写出目录事大，所以统一在这里消毒。
 */
export function batchFileNameOf(itemId: string): string {
    return `batch-${itemId.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")}.json`;
}

function requirementHash(requirement: string): string {
    return createHash("sha256").update(requirement.trim(), "utf8").digest("hex");
}

export function createArchitectCheckpoint(requirement: string, blueprint: ArchitectTask, batches: ArchitectBatch[] = []): ArchitectCheckpoint {
    const items = blueprint.foundationPlan.workItems ?? [];
    const allowed = new Set(items.map((item) => item.id));
    const seen = new Set<string>();
    for (const batch of batches) {
        if (!allowed.has(batch.itemId) || seen.has(batch.itemId)) throw new Error(`checkpoint 批次无效：${batch.itemId}`);
        seen.add(batch.itemId);
    }
    const expected = items.slice(0, batches.length).map((item) => item.id);
    if (expected.some((id, i) => id !== batches[i]?.itemId)) throw new Error("checkpoint 批次不是蓝图前缀");
    return {
        version: 1,
        requirementHash: requirementHash(requirement),
        projectId: blueprint.projectId,
        taskId: blueprint.taskId,
        blueprint,
        batches: [...batches],
        updatedAt: new Date().toISOString(),
    };
}

/**
 * 还差哪些工作项没拆（顺序即执行序）。空数组=蓝图已拆满。
 * 续跑就是"从这个切片的第一项接着做"——两条入口原本各自手写 items.slice(batches.length)，
 * 收成一处是为了让"跳过已完成批次"这条承诺有单测兜着，而不是靠两处代码长得像。
 */
export function pendingCheckpointWork(cp: ArchitectCheckpoint): WorkItem[] {
    return (cp.blueprint.foundationPlan.workItems ?? []).slice(cp.batches.length);
}

/**
 * 已交付判据 id（蓝图底线在前，各批按交付顺序追加）。
 * 这是批次拆解"撞车闸"的输入：续跑时必须**逐字重建**上次的清单，少一条就漏放重复 id。
 */
export function deliveredCheckIdsOf(cp: ArchitectCheckpoint): string[] {
    const ids = cp.blueprint.acceptanceChecks.map((c) => c.id);
    for (const b of cp.batches) ids.push(...b.checks.map((c) => c.id));
    return ids;
}

/** 原子落盘：先写同目录临时文件再 rename，避免"写一半断电"留下半截 checkpoint */
export function saveArchitectCheckpoint(file: string, cp: ArchitectCheckpoint): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    try {
        fs.writeFileSync(tmp, JSON.stringify({ ...cp, updatedAt: new Date().toISOString() }, null, 2), "utf8");
        fs.renameSync(tmp, file);
    } catch (e) {
        try { fs.rmSync(tmp); } catch { /* 连临时文件都没写出来：没什么可清的 */ }
        throw e;
    }
}

/**
 * 读盘恢复。**四道拒用闸**（损坏 / 版本 / 需求变更 / 身份不符）都在这里收口：
 * 宁可抛错让调用方显式决定"弃用还是中止"，也不静默拿旧档案续跑。
 */
export function loadArchitectCheckpoint(file: string, requirement: string, projectId: string, taskId: string): ArchitectCheckpoint {
    let raw: ArchitectCheckpoint;
    try {
        raw = JSON.parse(fs.readFileSync(file, "utf8")) as ArchitectCheckpoint;
    } catch (e) {
        throw new Error(`checkpoint 文件不可读或已损坏（${file}）：${(e as Error).message}`);
    }
    if (raw.version !== 1) throw new Error(`checkpoint 版本不兼容（文件是 ${String(raw.version)}，本程序只认 1）`);
    if (raw.requirementHash !== requirementHash(requirement)) throw new Error("需求已变化，拒绝复用旧 checkpoint");
    if (raw.projectId !== projectId || raw.taskId !== taskId) {
        throw new Error(`checkpoint 身份不匹配（文件是 ${raw.projectId}/${raw.taskId}，本次是 ${projectId}/${taskId}）`);
    }
    return createArchitectCheckpoint(requirement, raw.blueprint, raw.batches);
}

/**
 * 续跑的统一入口，也是**唯一的弃用策略点**：文件不在 → null（首次运行，不是错误）；
 * 文件在但不可用（损坏 / 版本 / 需求变更 / 身份不符）→ 记一行原因后返回 null，
 * 让调用方当首次运行重拆。
 *
 * 为什么不在这里抛：那四种"不可用"里，需求改过、换过身份都属于**用户的正常操作**，
 * 撞上的应该是一次干净的重拆，而不是"架构师拆解失败"把整次运行掐死。
 * 反过来，把这条策略写进两条入口各一份，迟早会漂成一个弃用一个中止。
 */
export function restoreArchitectCheckpoint(
    file: string, requirement: string, projectId: string, taskId: string,
    onDiscard?: (reason: string) => void,
): ArchitectCheckpoint | null {
    if (!fs.existsSync(file)) return null;
    try {
        return loadArchitectCheckpoint(file, requirement, projectId, taskId);
    } catch (e) {
        onDiscard?.((e as Error).message);
        return null;
    }
}

// ---------- 中间产物（_parts/）↔ 续跑档案 的桥 ----------

/**
 * 中间产物目录里的需求指纹文件名。
 * 档案（checkpoint.json）自带 requirementHash，但 `_parts/` 是"人查用"的产物，
 * 早先落盘时没留任何需求凭据——补一份指纹，让"需求改过没有"至少从这版起可查。
 */
export const REQUIREMENT_HASH_FILE = "requirement.sha256";

/** 落需求指纹（与 blueprint.json 同目录）。新建产物才有；历史产物没有。 */
export function saveRequirementHash(partsDir: string, requirement: string): void {
    fs.mkdirSync(partsDir, { recursive: true });
    fs.writeFileSync(path.join(partsDir, REQUIREMENT_HASH_FILE), requirementHash(requirement), "utf8");
}

function readRequirementHash(partsDir: string): string | null {
    try {
        const text = fs.readFileSync(path.join(partsDir, REQUIREMENT_HASH_FILE), "utf8").trim();
        return text || null;
    } catch {
        return null;
    }
}

/**
 * 从 `_parts/` 重建续跑档案：blueprint.json + 按蓝图顺序的 `batch-<itemId>.json` 前缀。
 *
 * WHY 需要它：`_parts/` 的落盘比档案早（档案是 9/16 才加的），于是存在一批
 * "中间产物齐全、却没有档案"的历史运行。按"只认档案"的续跑逻辑，它们会被判成从没拆过，
 * 已拆好的批次整份白烧——重建就是为了让这些运行从第一个缺失批次接着做。
 *
 * 闸门与档案读盘对齐，只有一处做不到：**判不了需求原文**。历史产物里没有指纹，
 * 只能告警放行（日志里明说"无法确认蓝图对应哪份需求"，要绝对干净就 --reset）；
 * 有指纹的产物则按指纹判，不符一律拒绝复用。
 * 蓝图损坏 / 身份不符 → 直接拒绝重建：宁可从蓝图重拆，也不接一个来路不明的骨架。
 */
export function rebuildArchitectCheckpointFromParts(
    partsDir: string, requirement: string, projectId: string, taskId: string,
    onWarn?: (reason: string) => void,
): ArchitectCheckpoint | null {
    const bpFile = path.join(partsDir, "blueprint.json");
    if (!fs.existsSync(bpFile)) return null;   // 没蓝图 = 真首次运行，不算异常

    let blueprint: ArchitectTask;
    try {
        blueprint = ArchitectTaskSchema.parse(JSON.parse(fs.readFileSync(bpFile, "utf8")));
    } catch (e) {
        onWarn?.(`blueprint.json 不可用（${(e as Error).message}）`);
        return null;
    }
    if (blueprint.projectId !== projectId || blueprint.taskId !== taskId) {
        onWarn?.(`blueprint.json 身份不符（文件是 ${blueprint.projectId}/${blueprint.taskId}，本次是 ${projectId}/${taskId}）`);
        return null;
    }
    const saved = readRequirementHash(partsDir);
    if (saved === null) {
        onWarn?.("_parts 里没有需求指纹（产物来自旧版本），无法确认这份蓝图对应的就是当前需求");
    } else if (saved !== requirementHash(requirement)) {
        onWarn?.("需求已变化，拒绝复用 _parts 中间产物");
        return null;
    }

    const batches: ArchitectBatch[] = [];
    for (const item of blueprint.foundationPlan.workItems ?? []) {
        const file = path.join(partsDir, batchFileNameOf(item.id));
        if (!fs.existsSync(file)) break;   // 前缀断了就停：后面的是"还没拆"，不是错误
        try {
            const b = ArchitectBatchSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
            if (b.projectId !== blueprint.projectId || b.taskId !== blueprint.taskId) {
                onWarn?.(`${batchFileNameOf(item.id)} 身份不符，从其停用（只续到前 ${batches.length} 批）`);
                break;
            }
            batches.push(b);
        } catch (e) {
            onWarn?.(`${batchFileNameOf(item.id)} 不可用（${(e as Error).message}），从其停用（只续到前 ${batches.length} 批）`);
            break;
        }
    }

    try {
        return createArchitectCheckpoint(requirement, blueprint, batches);
    } catch (e) {
        onWarn?.(`档案重建失败（${(e as Error).message}）`);
        return null;
    }
}
