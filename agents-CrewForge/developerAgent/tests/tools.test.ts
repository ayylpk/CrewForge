// tests/tools.test.ts —— 工具注册表、角色权限、写盘实链路（零 LLM）
import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../workspace";
import { createDeveloperToolRegistry, DEVELOPER_ROLE_NAME, WRITE_TOOLS } from "../tools/registry";
import type { ToolContext } from "../tools/registry";

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-dev-tools-"));
const ws = new Workspace({ projectDir, allowedRoots: ["frontend", "backend"] });
const registry = createDeveloperToolRegistry();

const devCtx: ToolContext = { workspace: ws, owner: "developerAgent", role: DEVELOPER_ROLE_NAME, taskId: "T1" };
const pmCtx: ToolContext = { workspace: ws, owner: "pm", role: "pm", taskId: "T1" };
const anonCtx: ToolContext = { workspace: ws, owner: "ghost", taskId: "T1" };

afterAll(() => { fs.rmSync(projectDir, { recursive: true, force: true }); });

describe("tools / 注册表", () => {
    it("注册了规格要求的 10 个工具", () => {
        const names = registry.names().sort();
        expect(names).toEqual([
            "delegateReadonly", "editFile", "gitDiff", "inspectTree", "mkdir",
            "readFile", "runBuild", "runCommand", "search", "writeFile",
        ]);
    });

    it("describe() 只吐元信息（渐进披露，不带实现）", () => {
        const defs = registry.describe();
        expect(defs.length).toBe(10);
        expect(Object.keys(defs[0] ?? {})).toEqual(["name", "description", "parameters"]);
    });

    it("未知工具直接拒绝", async () => {
        const r = await registry.invoke("nope", devCtx, {});
        expect(r.ok).toBe(false);
    });

    it("缺必填参数被拦", async () => {
        const r = await registry.invoke("readFile", devCtx, {});
        expect(r.ok).toBe(false);
        expect(r.output).toContain("path");
    });
});

describe("tools / 非 Developer 不能写盘", () => {
    it("三个写盘工具都标注了 WRITE_TOOLS", () => {
        expect([...WRITE_TOOLS].sort()).toEqual(["editFile", "mkdir", "writeFile"]);
    });

    it("PM 角色调 writeFile / mkdir / editFile 一律被拒", async () => {
        for (const tool of ["writeFile", "mkdir", "editFile"]) {
            const args: Record<string, unknown> = tool === "mkdir"
                ? { path: "backend/x" }
                : { path: "backend/x.ts", content: "x", find: "x", replace: "y" };
            const r = await registry.invoke(tool, pmCtx, args);
            expect(r.ok).toBe(false);
            expect(r.rejected?.code).toBe("NOT_DEVELOPER");
        }
    });

    it("未声明角色也不能写盘", async () => {
        const r = await registry.invoke("writeFile", anonCtx, { path: "backend/y.ts", content: "y" });
        expect(r.ok).toBe(false);
        expect(r.rejected?.code).toBe("NOT_DEVELOPER");
    });

    it("只读工具对非 Developer 开放", async () => {
        const r = await registry.invoke("inspectTree", pmCtx, {});
        expect(r.ok).toBe(true);
    });
});

describe("tools / Developer 写盘实链路", () => {
    it("writeFile → readFile 内容一致", async () => {
        const w = await registry.invoke("writeFile", devCtx, { path: "backend/src/B.java", content: "class B {}" });
        expect(w.ok).toBe(true);
        const r = await registry.invoke("readFile", devCtx, { path: "backend/src/B.java" });
        expect(r.ok).toBe(true);
        expect(r.output).toBe("class B {}");
    });

    it("editFile 找不到 find 就拒绝写（防盲改）", async () => {
        const r = await registry.invoke("editFile", devCtx, {
            path: "backend/src/B.java", find: "NOT_THERE", replace: "x",
        });
        expect(r.ok).toBe(false);
        expect(r.output).toContain("拒绝写入");
        // 文件必须没被动过
        expect(ws.readText("backend/src/B.java").content).toBe("class B {}");
    });

    it("editFile 命中才写", async () => {
        const r = await registry.invoke("editFile", devCtx, {
            path: "backend/src/B.java", find: "class B", replace: "class B2",
        });
        expect(r.ok).toBe(true);
        expect(ws.readText("backend/src/B.java").content).toBe("class B2 {}");
    });

    it("mkdir 建目录", async () => {
        const r = await registry.invoke("mkdir", devCtx, { path: "frontend/src/views" });
        expect(r.ok).toBe(true);
        expect(fs.existsSync(path.join(projectDir, "frontend/src/views"))).toBe(true);
    });

    it("写盘工具被 workspace 拦下时返回结构化 rejected", async () => {
        const r = await registry.invoke("writeFile", devCtx, { path: "backend/CONTRACTS.md", content: "x" });
        expect(r.ok).toBe(false);
        expect(r.rejected?.code).toBe("CONTRACT");
    });

    it("search 能搜到刚写的文件内容", async () => {
        const r = await registry.invoke("search", devCtx, { pattern: "class B2" });
        expect(r.ok).toBe(true);
        expect(r.output).toContain("B.java");
    });

    it("delegateReadonly 未接 analyzer 时如实拒绝（不假装有结果）", async () => {
        const r = await registry.invoke("delegateReadonly", devCtx, { question: "为什么 500" });
        expect(r.ok).toBe(false);
        expect(r.output).toContain("未接入");
    });

    it("接上 analyzer 后能返回分析（仍不写盘）", async () => {
        const ctx: ToolContext = { ...devCtx, analyzer: async () => "根因是空指针" };
        const r = await registry.invoke("delegateReadonly", ctx, { question: "为什么 500" });
        expect(r.ok).toBe(true);
        expect(r.output).toBe("根因是空指针");
        expect((r.meta as { readonly?: boolean })?.readonly).toBe(true);
    });
});
