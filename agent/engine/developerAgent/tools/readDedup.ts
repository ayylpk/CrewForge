// ============================================================
// tools/readDedup.ts —— 「同一份内容不重复进上下文」（搬运④，2026-09-18）
//
//   来源：claude-code FileReadTool 的 file_unchanged 去重（FileReadTool.ts:523-573）：
//   同一 (路径, 读取范围) 已经读过、且**文件 mtime 没变** → 只回一个 stub，
//   正文留给上下文里已有的那一份。它注释里的生产数据：约 **18% 的 Read 是同文件重复**。
//
//   为什么本仓更急需它（实测，不是推测）：
//   9/18 s1-crud-min 那一轮，299 次工具调用里 readFile 占 **235 次（79%）**，
//   而 writeFile 只有 **9 次（3%）** —— 每写 1 个文件要读 26 次。
//   根因不是模型笨：读回来的正文把上下文撑大 → 触发压缩 → 压缩后"看不见了" → 再读。
//   读与压缩互相喂养，预算全烧在这上面，w2 的 CRUD 到 40 分钟上限都没写完。
//   readFile.ts 自己的注释也早写过这个症状（"r4 里 103 次 readFile 的贡献因素之一"）。
//
//   与 observedFiles.ts 的分工：
//     · observedFiles 管「能不能改」（先读后改闸，claude-code FileEditTool 那一半）；
//     · 本文件管「要不要重发正文」（claude-code FileReadTool 这一半）。
//   两者同用 (taskId, owner) 口径——与 claude-code 一份 readFileState 供 Edit/Read
//   两用的形状一致，只是拆成两个模块，各自的失败面互不牵连。
//
//   进程级 Map 的边界（同 observedFiles）：崩溃/续跑后表为空 → 退化成"第一次读"，
//   安全侧失效（只会多发一次正文），可接受。
// ============================================================

/** 一次读取的"形状"：形状不同就不算同一份内容（读 1-50 行 ≠ 读整个文件） */
export interface ReadSignature {
    mode: "full" | "lines";
    /** 整读模式的字节上限 */
    maxBytes: number | null;
    /** 行模式的起始行（1 起） */
    offset: number | null;
    /** 行模式的行数（null = 读到末尾） */
    limit: number | null;
}

export function signatureKey(sig: ReadSignature): string {
    return `${sig.mode}|${sig.maxBytes ?? "-"}|${sig.offset ?? "-"}|${sig.limit ?? "-"}`;
}

interface ReadRecord {
    sigKey: string;
    mtimeMs: number;
    /** 记一个字节数：与 mtime 一起当"没变过"的判据，比单看 mtime 更抗磁盘时间戳粒度 */
    bytes: number;
}

const readState = new Map<string, Map<string, ReadRecord>>();

function keyOf(taskId: string, owner: string): string {
    return `${taskId}::${owner}`;
}

function bucket(taskId: string, owner: string, create: boolean): Map<string, ReadRecord> | undefined {
    const k = keyOf(taskId, owner);
    let m = readState.get(k);
    if (!m && create) {
        m = new Map();
        readState.set(k, m);
    }
    return m;
}

/**
 * 这次读取能不能只回 stub？
 *
 * 判据（三项全等才算"内容还在上下文里"）：
 *   ① 同一 (taskId, owner, 路径) 之前成功读过；
 *   ② 读取形状（mode/maxBytes/offset/limit）一模一样；
 *   ③ mtime 与字节数都没变。
 *
 * 任何一项不等 → 返回 false，调用方老老实实读一遍并发正文（保守优先：宁可多发，不可发错）。
 */
export function shouldAnswerUnchanged(o: {
    taskId: string; owner: string; path: string; sigKey: string; mtimeMs: number; bytes: number;
}): boolean {
    const rec = bucket(o.taskId, o.owner, false)?.get(o.path);
    if (!rec) return false;
    return rec.sigKey === o.sigKey && rec.mtimeMs === o.mtimeMs && rec.bytes === o.bytes;
}

/** 记下"这一份内容已经进过上下文了"。 */
export function rememberRead(o: {
    taskId: string; owner: string; path: string; sigKey: string; mtimeMs: number; bytes: number;
}): void {
    bucket(o.taskId, o.owner, true)!.set(o.path, { sigKey: o.sigKey, mtimeMs: o.mtimeMs, bytes: o.bytes });
}

/**
 * 忘掉某个文件的读状态 —— 写盘工具在**写成功后**必须调这个。
 *
 *   为什么不只靠 mtime 自失效：磁盘时间戳粒度可能粗到同一毫秒，快速"写→读"会撞上；
 *   而且"刚写完的文件"本来就该让模型看到自己写的确切落盘结果（原子替换后可能与它发来的不同）。
 *   显式忘掉，语义上最干净。
 */
export function forgetRead(taskId: string, owner: string, path: string): void {
    bucket(taskId, owner, false)?.delete(path);
}

/** 测试用：清空全部读状态 */
export function resetReadState(): void {
    readState.clear();
}

/**
 * 回给模型的 stub 正文。
 *
 *   要点（照 claude-code 的措辞改写成中文口径）：
 *     ① 说清"内容和上一条结果一致"，并**明确指向那条结果**，否则模型可能以为读失败；
 *     ② 给一条出路：上下文被压缩挤掉时能强制重读（claude-code 是纯 killswitch，
 *        本仓压缩更激进——长跑里正文确实可能已被摘要掉，所以更需要这条逃生门）。
 */
export function readUnchangedText(path: string): string {
    return `${path}：自上次读取后未改动，正文与你上一条 readFile 结果完全一致——直接引用那条结果，不要重复读取。`
        + `\n（若那份结果已被上下文压缩挤掉、或你确实需要再看一遍正文：带 force:true 重读。）`;
}
