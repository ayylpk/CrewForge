// tests/workspace.test.ts —— 写盘权限闸门（零 LLM）
import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace, WorkspaceViolation } from "../workspace";

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-dev-ws-"));
const ws = new Workspace({
    projectDir,
    allowedRoots: ["frontend", "backend"],
    commandAllowlist: ["node", "git"],
});
const meta = { owner: "developerAgent", taskId: "T1" };

afterAll(() => { fs.rmSync(projectDir, { recursive: true, force: true }); });

/** 期望被拒时抛出的错误码 */
function rejectCode(fn: () => unknown): string {
    try {
        fn();
        return "NO_THROW";
    } catch (e) {
        return e instanceof WorkspaceViolation ? e.code : `ERR:${(e as Error).message}`;
    }
}

describe("workspace / 允许的写入", () => {
    it("能建嵌套目录", () => {
        expect(ws.ensureDir("backend/src/main/java", meta)).toBe("backend/src/main/java");
        expect(fs.existsSync(path.join(projectDir, "backend/src/main/java"))).toBe(true);
    });

    it("能在 allowedRoots 内写文件（临时文件 + 原子替换）", () => {
        const r = ws.writeAtomic("backend/src/A.java", "class A {}", meta);
        expect(r.path).toBe("backend/src/A.java");
        expect(r.bytes).toBeGreaterThan(0);
        expect(fs.readFileSync(path.join(projectDir, "backend/src/A.java"), "utf-8")).toBe("class A {}");
    });

    it("frontend 也允许", () => {
        expect(ws.writeAtomic("frontend/src/main.ts", "console.log(1)", meta).path).toBe("frontend/src/main.ts");
    });

    it("读完能拿到内容", () => {
        expect(ws.readText("backend/src/A.java").content).toBe("class A {}");
    });

    it("审计记录带 owner / taskId / 字节数", () => {
        const recs = ws.records;
        expect(recs.length).toBeGreaterThanOrEqual(3);
        expect(recs.every((r) => r.owner === "developerAgent" && r.taskId === "T1")).toBe(true);
        expect(recs.some((r) => r.action === "mkdir")).toBe(true);
        expect(recs.some((r) => r.action === "write" && r.bytes > 0)).toBe(true);
    });
});

describe("workspace / 必须拒绝的写入", () => {
    it("路径逃逸 → ESCAPE", () => {
        expect(rejectCode(() => ws.writeAtomic("../evil.txt", "x", meta))).toBe("ESCAPE");
    });

    it("越出 allowedRoots → NOT_IN_ALLOWED_ROOTS", () => {
        expect(rejectCode(() => ws.writeAtomic("docs/a.md", "x", meta))).toBe("NOT_IN_ALLOWED_ROOTS");
    });

    it(".git → GIT", () => {
        expect(rejectCode(() => ws.writeAtomic("backend/.git/config", "x", meta))).toBe("GIT");
    });

    it("_verify / _engine2 → ENGINE_OWNED", () => {
        expect(rejectCode(() => ws.writeAtomic("backend/_verify/a.json", "x", meta))).toBe("ENGINE_OWNED");
        expect(rejectCode(() => ws.writeAtomic("backend/_engine2/a.json", "x", meta))).toBe("ENGINE_OWNED");
    });

    it("CONTRACTS.md → CONTRACT", () => {
        expect(rejectCode(() => ws.writeAtomic("backend/CONTRACTS.md", "x", meta))).toBe("CONTRACT");
    });

    it("acceptance-*.json → ACCEPTANCE", () => {
        expect(rejectCode(() => ws.writeAtomic("backend/acceptance-p1.json", "x", meta))).toBe("ACCEPTANCE");
    });

    it("测试脚本 → TEST_SCRIPT", () => {
        expect(rejectCode(() => ws.writeAtomic("backend/src/A.test.ts", "x", meta))).toBe("TEST_SCRIPT");
        expect(rejectCode(() => ws.writeAtomic("frontend/src/B.spec.ts", "x", meta))).toBe("TEST_SCRIPT");
    });

    it("读也不许逃出项目根 → ESCAPE", () => {
        expect(rejectCode(() => ws.readText("../../secret.txt"))).toBe("ESCAPE");
    });

    it("命令白名单外 → COMMAND_NOT_ALLOWED", async () => {
        await expect(ws.exec("rm", ["-rf", "/"])).rejects.toThrow();
    });
});

describe("workspace / 契约", () => {
    it("内置禁止清单可导出（供 policies 对照）", () => {
        const f = Workspace.builtinForbidden();
        expect(f.segments).toContain(".git");
        expect(f.segments).toContain("_engine2");
        expect(f.files).toContain("CONTRACTS.md");
        expect(f.patterns.length).toBeGreaterThan(0);
    });
});
