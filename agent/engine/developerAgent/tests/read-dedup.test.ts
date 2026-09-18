// tests/read-dedup.test.ts —— readFile 去重（"同一份内容不重复进上下文"）
//
//   动因是实测：9/18 s1-crud-min 那轮 299 次工具调用里 readFile 235 次（79%）、
//   writeFile 9 次（3%）——"读 → 撑大上下文 → 压缩 → 看不见了 → 再读"的自喂循环
//   把预算烧光，w2 的 CRUD 到 40 分钟上限都没写完。
//   机制来源：claude-code FileReadTool 的 file_unchanged（FileReadTool.ts:523-573）。
//
//   这批用例盯的就是"什么时候该去重、什么时候绝不许去重"——后者同样重要：
//   文件改过、读取范围不同、上下文可能已被压缩挤掉时，都必须老老实实回正文。
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../workspace";
import { readFileTool } from "../tools/readFile";
import { writeFileTool } from "../tools/writeFile";
import { editFileTool } from "../tools/editFile";
import { forgetRead, rememberRead, resetReadState, shouldAnswerUnchanged, signatureKey } from "../tools/readDedup";
import type { ToolContext } from "../tools/registry";

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-read-dedup-"));
const ws = new Workspace({ projectDir, allowedRoots: ["frontend", "backend"], commandAllowlist: ["node"] });

const ctxOf = (taskId: string): ToolContext => ({ workspace: ws, owner: "developerAgent", taskId, role: "developer" });

/** 写一个文件到项目里（绕过工具，直接落盘；用来模拟"文件被外部改了"） */
function put(rel: string, content: string): void {
    const abs = path.join(projectDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf-8");
}

const SRC = "backend/src/main/java/A.java";
const BODY_V1 = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");

beforeEach(() => { resetReadState(); });
afterAll(() => { fs.rmSync(projectDir, { recursive: true, force: true }); });

describe("readFile 去重：命中即只回 stub（正文不重发）", () => {
    it("★ 同文件同范围连读两次：第二次只回提示，不再发正文", async () => {
        put(SRC, BODY_V1);
        const ctx = ctxOf("T-dedup");

        const a = await readFileTool.run(ctx, { path: SRC });
        expect(a.ok).toBe(true);
        expect(a.output).toContain("line 40");                 // 第一次是真正文
        expect(a.meta?.unchanged).toBeUndefined();

        const b = await readFileTool.run(ctx, { path: SRC });
        expect(b.ok).toBe(true);
        expect(b.meta?.unchanged).toBe(true);                  // 第二次是 stub
        expect(b.output).not.toContain("line 40");             // ★ 正文没有重发
        expect(b.output).toContain("未改动");
        expect(b.output).toContain("上一条 readFile 结果");      // 明确指向已有那条，不让模型以为读取失败
        expect(b.output).toContain("force");                    // 并给出逃生门
    });

    it("★ 省下的正是上下文：stub 比正文短一个数量级", async () => {
        put(SRC, BODY_V1);
        const ctx = ctxOf("T-size");
        const first = await readFileTool.run(ctx, { path: SRC });
        const second = await readFileTool.run(ctx, { path: SRC });
        expect(second.output.length).toBeLessThan(first.output.length / 2);
    });

    it("stub 命中仍算「已观察」——先读后改闸不能因此拒写", async () => {
        put(SRC, BODY_V1);
        const ctx = ctxOf("T-observe");
        await readFileTool.run(ctx, { path: SRC });            // 第一次读
        await readFileTool.run(ctx, { path: SRC });            // 第二次命中 stub
        const w = await writeFileTool.run(ctx, { path: SRC, content: "class A {}" });
        expect(w.ok).toBe(true);                               // 没被 FS_NOT_OBSERVED 拦下
    });
});

describe("readFile 去重：这些情况绝不许去重（保守优先）", () => {
    it("★ 文件在磁盘上被改过 → 必须回正文", async () => {
        put(SRC, BODY_V1);
        const ctx = ctxOf("T-changed");
        await readFileTool.run(ctx, { path: SRC });

        put(SRC, BODY_V1 + "\n// 新加的一行");
        const b = await readFileTool.run(ctx, { path: SRC });
        expect(b.meta?.unchanged).toBeUndefined();
        expect(b.output).toContain("新加的一行");
    });

    it("★ 读取范围不同（offset/limit）→ 不算同一份内容", async () => {
        put(SRC, BODY_V1);
        const ctx = ctxOf("T-range");
        await readFileTool.run(ctx, { path: SRC, offset: 1, limit: 5 });
        const b = await readFileTool.run(ctx, { path: SRC, offset: 6, limit: 5 });
        expect(b.meta?.unchanged).toBeUndefined();
        expect(b.output).toContain("line 6");
    });

    it("★ 同一范围重复续读 → 去重；换个 limit 就要重发", async () => {
        put(SRC, BODY_V1);
        const ctx = ctxOf("T-range2");
        await readFileTool.run(ctx, { path: SRC, offset: 1, limit: 5 });
        const same = await readFileTool.run(ctx, { path: SRC, offset: 1, limit: 5 });
        expect(same.meta?.unchanged).toBe(true);
        const other = await readFileTool.run(ctx, { path: SRC, offset: 1, limit: 6 });
        expect(other.meta?.unchanged).toBeUndefined();
    });

    it("★ force:true = 逃生门：上下文被压缩挤掉后能强制再看一遍正文", async () => {
        put(SRC, BODY_V1);
        const ctx = ctxOf("T-force");
        await readFileTool.run(ctx, { path: SRC });
        const forced = await readFileTool.run(ctx, { path: SRC, force: true });
        expect(forced.meta?.unchanged).toBeUndefined();
        expect(forced.output).toContain("line 40");
    });

    it("★ 整读的 maxBytes 不同 → 内容可能不同，不许顶替", async () => {
        put(SRC, BODY_V1);
        const ctx = ctxOf("T-maxbytes");
        await readFileTool.run(ctx, { path: SRC, maxBytes: 100 });
        const b = await readFileTool.run(ctx, { path: SRC, maxBytes: 4096 });
        expect(b.meta?.unchanged).toBeUndefined();
    });

    it("★ 不同任务（taskId）之间不互相顶替", async () => {
        put(SRC, BODY_V1);
        await readFileTool.run(ctxOf("T-a"), { path: SRC });
        const b = await readFileTool.run(ctxOf("T-b"), { path: SRC });
        expect(b.meta?.unchanged).toBeUndefined();
    });
});

describe("readFile 去重：写盘必须让去重失效", () => {
    it("★ writeFile 之后立刻读 → 回的是**落盘后的真实内容**，不是 stub", async () => {
        put(SRC, BODY_V1);
        const ctx = ctxOf("T-after-write");
        await readFileTool.run(ctx, { path: SRC });                        // 读过旧正文

        await writeFileTool.run(ctx, { path: SRC, content: "class A { /* v2 */ }" });
        const after = await readFileTool.run(ctx, { path: SRC });
        expect(after.meta?.unchanged).toBeUndefined();
        expect(after.output).toContain("v2");
    });

    it("★ editFile 之后立刻读 → 同样是新内容", async () => {
        put(SRC, BODY_V1);
        const ctx = ctxOf("T-after-edit");
        await readFileTool.run(ctx, { path: SRC });

        const e = await editFileTool.run(ctx, { path: SRC, find: "line 1", replace: "LINE-ONE" });
        expect(e.ok).toBe(true);
        const after = await readFileTool.run(ctx, { path: SRC });
        expect(after.meta?.unchanged).toBeUndefined();
        expect(after.output).toContain("LINE-ONE");
    });
});

describe("去重的可观测性：命中要能在台账留痕", () => {
    it("★ 命中时通过 ctx.note 记一行 read_dedup_hit（只读工具的返回不进 completed_tool_call，不记这里就量不到效果）", async () => {
        put(SRC, BODY_V1);
        const seen: { event: string; payload?: Record<string, unknown> }[] = [];
        const ctx: ToolContext = {
            workspace: ws, owner: "developerAgent", taskId: "T-note", role: "developer",
            note: (event, payload) => { seen.push({ event, payload }); },
        };

        await readFileTool.run(ctx, { path: SRC });                 // 第一次：真读，不该记账
        expect(seen.filter((s) => s.event === "read_dedup_hit")).toHaveLength(0);

        await readFileTool.run(ctx, { path: SRC });                 // 第二次：命中，记一行
        const hits = seen.filter((s) => s.event === "read_dedup_hit");
        expect(hits).toHaveLength(1);
        expect(hits[0]!.payload?.path).toBe(SRC);
        expect(typeof hits[0]!.payload?.sigKey).toBe("string");
    });

    it("未注入 note 也不炸（子 Agent / 测试里的只读工具盒拿不到这个端口）", async () => {
        put(SRC, BODY_V1);
        const ctx = ctxOf("T-nonote");
        await readFileTool.run(ctx, { path: SRC });
        const b = await readFileTool.run(ctx, { path: SRC });
        expect(b.meta?.unchanged).toBe(true);
    });
});

describe("readDedup 纯函数口径", () => {
    it("signatureKey：形状不同 → key 不同；形状相同 → key 相同", () => {
        const full = signatureKey({ mode: "full", maxBytes: 256 * 1024, offset: null, limit: null });
        const lines = signatureKey({ mode: "lines", maxBytes: null, offset: 1, limit: 5 });
        expect(full).not.toBe(lines);
        expect(signatureKey({ mode: "full", maxBytes: 256 * 1024, offset: null, limit: null })).toBe(full);
        expect(signatureKey({ mode: "lines", maxBytes: null, offset: 1, limit: 6 })).not.toBe(lines);
    });

    it("shouldAnswerUnchanged：路径记录/形状/mtime/字节 四项全等才为 true", () => {
        const k = { taskId: "T-pure", owner: "dev", path: "a.ts", sigKey: "full|-|-|-", mtimeMs: 100, bytes: 10 };
        expect(shouldAnswerUnchanged(k)).toBe(false);                       // 从没记录过
        rememberRead(k);
        expect(shouldAnswerUnchanged(k)).toBe(true);                        // 四项全等
        expect(shouldAnswerUnchanged({ ...k, mtimeMs: 101 })).toBe(false);  // mtime 变了
        expect(shouldAnswerUnchanged({ ...k, bytes: 11 })).toBe(false);     // 字节数变了
        expect(shouldAnswerUnchanged({ ...k, sigKey: "full|100|-|-" })).toBe(false); // 读取形状变了
        expect(shouldAnswerUnchanged({ ...k, path: "b.ts" })).toBe(false);  // 另一个文件
        expect(shouldAnswerUnchanged({ ...k, owner: "other" })).toBe(false); // 另一个 owner
    });

    it("forgetRead 之后不再去重", async () => {
        put(SRC, BODY_V1);
        const ctx = ctxOf("T-forget");
        await readFileTool.run(ctx, { path: SRC });
        forgetRead("T-forget", "developerAgent", SRC);
        const b = await readFileTool.run(ctx, { path: SRC });
        expect(b.meta?.unchanged).toBeUndefined();
    });
});
