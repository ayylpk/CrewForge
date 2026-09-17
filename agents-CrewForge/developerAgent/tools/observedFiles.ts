// ============================================================
// tools/observedFiles.ts —— 「先读后改」观察表（搬运③，2026-09-17）
//
//   来源：
//     · claude-code FileEditTool 的 readFileState 硬闸（FileEditTool.ts:275-287：
//       "File has not been read yet" → 拒绝编辑）；
//     · dsh fs-observation-policy 的 FS_NOT_OBSERVED（未观察到的文件不许动，
//       且"写入"本身也算一次观察）。
//
//   机制：按 (taskId, owner) 记一组"已观察路径"。readFile 成功 → 标记；
//   writeFile 成功 → 标记（模型自己写的内容它当然知道）。writeFile 覆盖一个
//   **已存在且非空**、但从未被本任务读过/写过的文件 → 拒绝，并给出出路
//   （先 readFile，或用 editFile 做精确局部替换）。
//
//   s4 实弹动因：developer 预演发现 PATCH 500 后，一次 writeFile 批量重写 17 个
//   文件，把已经通过的 create(201) 也改挂（回归）——根因是它可以盲写任何文件。
//   这道闸不靠提示词自律，靠工具层拒绝（dsh 口径）。
//
//   进程级 Map 的边界：同一进程内多任务并发时按 key 隔离；进程崩溃重放后表为空，
//   后果只是模型要重新 readFile 一遍——安全侧失效，可接受。
// ============================================================

const observed = new Map<string, Set<string>>();

export function observeKey(taskId: string, owner: string): string {
    return `${taskId}::${owner}`;
}

export function markObserved(taskId: string, owner: string, path: string): void {
    const key = observeKey(taskId, owner);
    let set = observed.get(key);
    if (!set) {
        set = new Set();
        observed.set(key, set);
    }
    set.add(path);
}

export function isObserved(taskId: string, owner: string, path: string): boolean {
    return observed.get(observeKey(taskId, owner))?.has(path) ?? false;
}
