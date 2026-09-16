import { describe, expect, it } from "bun:test";
import {
    batchFileNameOf, createArchitectCheckpoint, deliveredCheckIdsOf, loadArchitectCheckpoint,
    pendingCheckpointWork, rebuildArchitectCheckpointFromParts, restoreArchitectCheckpoint,
    saveArchitectCheckpoint, saveRequirementHash,
} from "../architectCheckpoint";
import type { ArchitectBatch, ArchitectTask } from "../protocol";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const blueprint = {
    type: "architect_task", projectId: "p", taskId: "t", allowedRoots: ["backend"], forbiddenPaths: [],
    requirementSnapshot: "需求", domainModel: [], contract: { endpoints: [] },
    acceptanceChecks: [{ id: "ac-1" }],
    foundationPlan: { workItems: [{ id: "w1", kind: "backend" }, { id: "w2", kind: "backend" }, { id: "w3", kind: "backend" }] },
} as unknown as ArchitectTask;
const batch = (itemId: string, checkIds: string[] = []) =>
    ({
        type: "architect_batch", projectId: "p", taskId: "t", itemId, detail: itemId,
        checks: checkIds.map((id) => ({ id })),
    }) as unknown as ArchitectBatch;

/** 每个用例一份独立临时目录（互不干扰），返回其中的档案路径 */
function tmpFile(name = "checkpoint.json"): string {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-checkpoint-")), name);
}

/** 落一份 w1 已完成的档案，返回其路径 */
function savedWithW1(requirement = "需求"): string {
    const file = tmpFile();
    saveArchitectCheckpoint(file, createArchitectCheckpoint(requirement, blueprint, [batch("w1")]));
    return file;
}

describe("architect checkpoint / 续跑切片", () => {
    it("已完成 w1..w2 → 只从第一个缺失批次 w3 继续，已完成的批次原样留在档案里", () => {
        const cp = createArchitectCheckpoint("需求", blueprint, [batch("w1"), batch("w2")]);
        expect(pendingCheckpointWork(cp).map((w) => w.id)).toEqual(["w3"]);
        expect(cp.batches.map((b) => b.itemId)).toEqual(["w1", "w2"]);
    });

    it("蓝图拆满 → 待拆为空（直接进装配，一发 LLM 都不再调）", () => {
        const cp = createArchitectCheckpoint("需求", blueprint, [batch("w1"), batch("w2"), batch("w3")]);
        expect(pendingCheckpointWork(cp)).toEqual([]);
    });

    it("已交付判据 = 蓝图底线 + 各批按序（续跑靠它重建撞车闸的输入，少一条就漏放重复 id）", () => {
        const cp = createArchitectCheckpoint("需求", blueprint, [batch("w1", ["ac-2", "ac-3"]), batch("w2", ["ac-4"])]);
        expect(deliveredCheckIdsOf(cp)).toEqual(["ac-1", "ac-2", "ac-3", "ac-4"]);
    });

    it("批次必须是最新前缀：跳批/重批在构造期就抛，不留到装配才发现", () => {
        expect(() => createArchitectCheckpoint("需求", blueprint, [batch("w2")])).toThrow(/前缀/);
        expect(() => createArchitectCheckpoint("需求", blueprint, [batch("w1"), batch("w1")])).toThrow(/批次无效/);
    });
});

describe("architect checkpoint / 拒用与弃用", () => {
    it("需求变化 → 拒绝复用旧 checkpoint", () => {
        const file = savedWithW1();
        expect(() => loadArchitectCheckpoint(file, "另一份需求", "p", "t")).toThrow(/需求已变化/);
    });

    it("身份不匹配 → 拒绝复用，且点名两边分别是哪个身份", () => {
        const file = savedWithW1();
        expect(() => loadArchitectCheckpoint(file, "需求", "other-p", "t")).toThrow(/身份不匹配（文件是 p\/t，本次是 other-p\/t）/);
    });

    it("档案文件损坏 → 报「损坏」，不让 JSON.parse 的原文裸奔到用户面前", () => {
        const file = tmpFile();
        fs.writeFileSync(file, "{ 半截", "utf8");
        expect(() => loadArchitectCheckpoint(file, "需求", "p", "t")).toThrow(/损坏/);
    });

    it("restore：文件不在 → null（首次运行不是错误），一次都不抛", () => {
        expect(restoreArchitectCheckpoint(tmpFile("nope.json"), "需求", "p", "t")).toBeNull();
    });

    it("restore：档案在但不可复用 → 记一行原因后当首次运行返回 null（不再把整次运行掐死）", () => {
        const file = savedWithW1();
        const reasons: string[] = [];
        expect(restoreArchitectCheckpoint(file, "改过的需求", "p", "t", (r) => reasons.push(r))).toBeNull();
        expect(reasons.length).toBe(1);
        expect(reasons[0]).toContain("需求已变化");
    });

    it("restore：档案可用 → 原样恢复出已完成批次与待拆切片", () => {
        const file = savedWithW1();
        const cp = restoreArchitectCheckpoint(file, "需求", "p", "t");
        expect(cp?.batches.map((b) => b.itemId)).toEqual(["w1"]);
        expect(pendingCheckpointWork(cp!).map((w) => w.id)).toEqual(["w2", "w3"]);
    });

    it("原子落盘不留残渣：save 之后目录里只剩正式档案，没有 tmp-* 尾巴", () => {
        const file = savedWithW1();
        expect(fs.readdirSync(path.dirname(file))).toEqual(["checkpoint.json"]);
    });
});

describe("architect checkpoint / 中间产物文件名", () => {
    it("itemId 是模型自由文本：路径分隔符与保留字符一律消毒，不给写出 parts 目录的机会", () => {
        expect(batchFileNameOf("w1")).toBe("batch-w1.json");
        expect(batchFileNameOf("../w2")).toBe("batch-.._w2.json");
        expect(batchFileNameOf("a/b\\c:d")).toBe("batch-a_b_c_d.json");
    });
});

// ---------- 从 _parts 重建（兜"中间产物齐全、却没有档案"的历史运行） ----------

/**
 * schema 级合法的蓝图/批次：重建路径会走 ArchitectTaskSchema/ArchitectBatchSchema.parse，
 * 所以不能借上面那份 `as unknown as` 的宽松 fixture（那份 requirementSnapshot 是字符串）。
 */
const PARSABLE_BLUEPRINT = {
    type: "architect_task", projectId: "p", taskId: "t",
    requirementSnapshot: { goal: "目标" },
    stackProfile: { frontend: "vue3+vite", backend: "node+express", database: "sqlite" },
    domainModel: { entity: "Note(id,title)" },
    contract: { version: "1", endpoints: [{ method: "GET", path: "/api/notes", purpose: "列表", response: "数组" }] },
    foundationPlan: {
        dirs: ["backend"],
        workItems: [
            { id: "w1", kind: "foundation" }, { id: "w2", kind: "backend" }, { id: "w3", kind: "backend" },
        ],
    },
    allowedRoots: ["backend"], forbiddenPaths: [],
    acceptanceChecks: [{ id: "ac-1", kind: "COMPILE", target: "backend" }],
    developerInstructions: "按顺序做",
};
const parsableBatch = (itemId: string) =>
    ({ type: "architect_batch", projectId: "p", taskId: "t", itemId, detail: `d-${itemId}`, checks: [] });

/** 造一个 _parts 目录：blueprint.json + 指定 id 的 batch 文件（默认附需求指纹） */
function partsDirWith(batchIds: string[], o: { requirement?: string; writeHash?: boolean } = {}): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-parts-"));
    fs.writeFileSync(path.join(dir, "blueprint.json"), JSON.stringify(PARSABLE_BLUEPRINT), "utf8");
    for (const id of batchIds) {
        fs.writeFileSync(path.join(dir, batchFileNameOf(id)), JSON.stringify(parsableBatch(id)), "utf8");
    }
    if (o.writeHash !== false) saveRequirementHash(dir, o.requirement ?? "需求");
    return dir;
}

describe("architect checkpoint / 从 _parts 重建档案", () => {
    it("中间产物齐全但没档案 → 重建出已完成前缀，续跑从第一个缺失批次起（历史运行不白烧）", () => {
        const cp = rebuildArchitectCheckpointFromParts(partsDirWith(["w1", "w2"]), "需求", "p", "t");
        expect(cp?.batches.map((b) => b.itemId)).toEqual(["w1", "w2"]);
        expect(pendingCheckpointWork(cp!).map((w) => w.id)).toEqual(["w3"]);
    });

    it("没有 blueprint.json → null（真首次运行，不算异常）", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewforge-parts-"));
        expect(rebuildArchitectCheckpointFromParts(dir, "需求", "p", "t")).toBeNull();
    });

    it("前缀断在中间 → 只重建到断点（后面的是「还没拆」，不是错误）", () => {
        const cp = rebuildArchitectCheckpointFromParts(partsDirWith(["w1", "w3"]), "需求", "p", "t"); // 缺 w2
        expect(cp?.batches.map((b) => b.itemId)).toEqual(["w1"]);
    });

    it("蓝图身份不符 / 需求指纹不符 → 拒绝重建（宁可从蓝图重拆，也不接一个来路不明的骨架）", () => {
        const dir = partsDirWith(["w1"]);
        expect(rebuildArchitectCheckpointFromParts(dir, "需求", "other-p", "t")).toBeNull();
        expect(rebuildArchitectCheckpointFromParts(dir, "改过的需求", "p", "t")).toBeNull();
    });

    it("旧产物没有需求指纹 → 告警放行（判不了原文，但不能因此把整份产物作废）", () => {
        const dir = partsDirWith(["w1"], { writeHash: false });
        const warns: string[] = [];
        const cp = rebuildArchitectCheckpointFromParts(dir, "任意需求", "p", "t", (r) => warns.push(r));
        expect(cp?.batches.map((b) => b.itemId)).toEqual(["w1"]);
        expect(warns[0]).toContain("没有需求指纹");
    });

    it("某个批次文件损坏 → 从其停用，不整份作废", () => {
        const dir = partsDirWith(["w1", "w2"]);
        fs.writeFileSync(path.join(dir, batchFileNameOf("w2")), "{ 半截", "utf8");
        const warns: string[] = [];
        const cp = rebuildArchitectCheckpointFromParts(dir, "需求", "p", "t", (r) => warns.push(r));
        expect(cp?.batches.map((b) => b.itemId)).toEqual(["w1"]);
        expect(warns[0]).toContain("不可用");
    });

    it("重建产物能落盘再读回：指纹一致，且后续续跑走的就是权威档案", () => {
        const dir = partsDirWith(["w1"]);
        const cp = rebuildArchitectCheckpointFromParts(dir, "需求", "p", "t")!;
        const file = path.join(dir, "checkpoint.json");
        saveArchitectCheckpoint(file, cp);
        const back = loadArchitectCheckpoint(file, "需求", "p", "t");
        expect(back.batches.map((b) => b.itemId)).toEqual(["w1"]);
    });
});
