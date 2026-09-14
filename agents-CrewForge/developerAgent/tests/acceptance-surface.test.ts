// ============================================================
// tests/acceptance-surface.test.ts —— 验收面不可写（零 LLM）
//
//   规格六：Developer 能改的只有**生成项目自己的源码**。以下一律拒绝：
//     CONTRACTS.md / acceptance-*.json / TestAgent 验收脚本（项目根 scripts/）/
//     _verify / _engine2 / .git / CrewForge 控制平面源码 / Ledger
//
//   两条腿都要钉住：
//     ① 文件工具（writeAtomic）在路径层直接拒绝；
//     ② 命令层（子进程绕过去写 / 删）也必须被判成"项目外写入"——不能只挡工具。
//
//   验收脚本的保护**不能只依赖任务包里的 forbiddenPaths**：任务包是模型生成的，
//   正是可能被绕过的那一环。所以项目根 scripts/ 是内置禁区。
// ============================================================

import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../workspace";
import { DeveloperLedger } from "../ledger";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-accept-surface-"));
const NODE = process.execPath;
const opened: DeveloperLedger[] = [];
let seq = 0;

afterAll(() => {
    for (const l of opened) { try { l.close(); } catch { /* 已关 */ } }
});

function newProject(name: string): string {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, "backend"), { recursive: true });
    fs.mkdirSync(path.join(dir, "frontend"), { recursive: true });
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "CONTRACTS.md"), "# 契约（TestAgent 侧，不可写）\n");
    fs.writeFileSync(path.join(dir, "acceptance-p1.json"), '{"checks":["api-projects"]}\n');
    fs.writeFileSync(path.join(dir, "scripts", "verify-p1-api.mjs"),
        '// TestAgent 侧验收脚本\nif (!ok) { throw new Error("FAIL"); }\n');
    return dir;
}

function wsOf(projectDir: string, o: {
    /** 故意把 scripts 也放进 allowedRoots：即便架构师写错授权，内置禁区仍要拦得住 */
    allowedRoots?: string[];
    forbiddenPaths?: string[];
    ledger?: DeveloperLedger;
    watchIntervalMs?: number;
} = {}): Workspace {
    const ledger = o.ledger ?? DeveloperLedger.open(path.join(root, `as-${seq++}.db`), "p1:t1");
    if (!opened.includes(ledger)) opened.push(ledger);
    return new Workspace({
        projectDir,
        allowedRoots: o.allowedRoots ?? ["backend", "frontend", "scripts"],
        forbiddenPaths: o.forbiddenPaths ?? [],
        sandbox: { mode: "soft", watchIntervalMs: o.watchIntervalMs ?? 150 },
    }, (rec) => ledger.appendEvent("write_audit", rec), {
        onViolation: (v) => ledger.recordViolation({
            code: v.code, target: v.target, message: v.message, taskId: "T1",
        }),
    });
}

const meta = { owner: "developerAgent", taskId: "T1" };
const rejectCode = (fn: () => unknown): string => {
    try { fn(); return "NO_THROW"; } catch (e) { return (e as { code?: string }).code ?? "ERR"; }
};

describe("验收面不可写 / 文件工具层", () => {
    it("Developer 尝试写 TestAgent 验收脚本 → 拒绝（项目根 scripts/ 是内置禁区）", () => {
        const ws = wsOf(newProject("scripts-blk"));
        expect(rejectCode(() => ws.writeAtomic("scripts/verify-p1-api.mjs", "// 改成永远通过\n", meta)))
            .toBe("TEST_SCRIPT");
        expect(rejectCode(() => ws.writeAtomic("scripts/verify-p1-frontend.mjs", "// x\n", meta)))
            .toBe("TEST_SCRIPT");
        expect(rejectCode(() => ws.writeAtomic("scripts", "x", meta))).toBe("TEST_SCRIPT");
    });

    it("backend/scripts 不受影响：那是生成项目自己的脚本目录，不是验收面", () => {
        const ws = wsOf(newProject("be-scripts-ok"));
        expect(rejectCode(() => ws.writeAtomic("backend/scripts/seed.mjs", "// 自己的\n", meta)))
            .toBe("NO_THROW");
    });

    it("Developer 尝试改 CONTRACTS.md → 拒绝", () => {
        const ws = wsOf(newProject("contract-blk"));
        expect(rejectCode(() => ws.writeAtomic("CONTRACTS.md", "# 还是我说了算\n", meta))).toBe("CONTRACT");
        expect(rejectCode(() => ws.writeAtomic("frontend/CONTRACTS.md", "x", meta))).toBe("CONTRACT");
    });

    it("Developer 尝试改 acceptance-*.json → 拒绝", () => {
        const ws = wsOf(newProject("accept-blk"));
        expect(rejectCode(() => ws.writeAtomic("acceptance-p1.json", '{"checks":[]}', meta))).toBe("ACCEPTANCE");
        expect(rejectCode(() => ws.writeAtomic("backend/acceptance-p2.json", "{}", meta))).toBe("ACCEPTANCE");
    });

    it("Developer 尝试写测试文件 / _verify / _engine2 / .git → 拒绝", () => {
        const ws = wsOf(newProject("misc-blk"));
        expect(rejectCode(() => ws.writeAtomic("frontend/src/A.test.ts", "// 断言删掉\n", meta))).toBe("TEST_SCRIPT");
        expect(rejectCode(() => ws.writeAtomic("_verify/a.json", "{}", meta))).toBe("ENGINE_OWNED");
        expect(rejectCode(() => ws.writeAtomic("_engine2/a.json", "{}", meta))).toBe("ENGINE_OWNED");
        expect(rejectCode(() => ws.writeAtomic("backend/.git/config", "x", meta))).toBe("GIT");
        // CrewForge 控制平面源码：即便 projectDir 被误配到控制平面里也拦得住
        expect(ws.checkPath(path.resolve(import.meta.dir, "..", "workspace.ts"))).toBe("CONTROL_PLANE");
    });

    it("任务包忘了声明 forbiddenPaths，验收脚本依然写不进去（内置禁区不依赖任务包）", () => {
        const ws = wsOf(newProject("no-pack-decl"), { forbiddenPaths: [] });
        expect(rejectCode(() => ws.writeAtomic("scripts/verify-p1-api.mjs", "// 绕过\n", meta))).toBe("TEST_SCRIPT");
    });

    it("禁止清单可导出（供 policies / 架构师对照，不靠口头约定）", () => {
        const f = Workspace.builtinForbidden();
        expect(f.segments).toContain("_engine2");
        expect(f.segments).toContain("_verify");
        expect(f.files).toContain("CONTRACTS.md");
        expect(f.relPaths).toContain("scripts");
    });
});

describe("验收面不可写 / 命令层（子进程绕过工具也要拦）", () => {
    it("子进程删掉验收脚本 → 判定为项目外写入并留违规证据", async () => {
        const dir = newProject("del-script");
        const ledger = DeveloperLedger.open(path.join(root, `del-${seq++}.db`), "p1:t1");
        if (!opened.includes(ledger)) opened.push(ledger);
        const ws = wsOf(dir, { ledger, watchIntervalMs: 150 });

        const r = await ws.exec(NODE, ["-e", "require('fs').unlinkSync('scripts/verify-p1-api.mjs')"]);
        expect(r.violations?.some((v) => v.code === "OUT_OF_PROJECT_WRITE")).toBe(true);
        expect(ledger.listViolations().length).toBeGreaterThan(0);
    }, 30_000);

    it("子进程把验收脚本改成永远通过 → 同样被判违规", async () => {
        const dir = newProject("rewrite-script");
        const ledger = DeveloperLedger.open(path.join(root, `rw-${seq++}.db`), "p1:t1");
        if (!opened.includes(ledger)) opened.push(ledger);
        const ws = wsOf(dir, { ledger, watchIntervalMs: 150 });

        const r = await ws.exec(NODE, ["-e",
            "require('fs').writeFileSync('scripts/verify-p1-api.mjs','process.exit(0)')"]);
        expect(r.violations?.some((v) => v.code === "OUT_OF_PROJECT_WRITE")).toBe(true);
    }, 30_000);

    it("子进程改 CONTRACTS.md → 被判违规（原有能力不回归）", async () => {
        const dir = newProject("rewrite-contract");
        const ws = wsOf(dir, { watchIntervalMs: 150 });
        const r = await ws.exec(NODE, ["-e", "require('fs').writeFileSync('CONTRACTS.md','hacked')"]);
        expect(r.violations?.some((v) => v.code === "OUT_OF_PROJECT_WRITE")).toBe(true);
    }, 30_000);
});
