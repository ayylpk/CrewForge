// tests/guardrails.test.ts —— C1 代码级护栏（默认拒绝 + 单调 deny）
//
//   铁律：这些"禁止"必须由**代码**拦下，不能寄望提示词——
//   `skills/backend-development.md` 的"禁止一次生成整个后端目录"写在提示词里被无视过（p7 llm#16）。
import { describe, expect, it } from "bun:test";
import {
    DEFAULT_GUARDRAILS, MAX_SINGLE_WRITE_BYTES, MAX_WRITES_PER_BATCH,
    evaluateGuardrails, evaluateWriteBatch,
} from "../guardrails";

describe("C1 护栏：危险 shell 命令一律拒绝（代码级，不靠提示词）", () => {
    it("命中 rm -rf / del /s /q / format / shutdown → 拒绝", () => {
        for (const cmd of ["rm -rf /", "rm -fr build", "del /s /q C:\\x", "format D:", "shutdown /s"]) {
            expect(evaluateGuardrails("shell", { command: cmd })?.id).toBe("dangerous-shell");
        }
    });

    it("普通命令放行（不误伤）", () => {
        expect(evaluateGuardrails("shell", { command: "npm run build 2>&1 | tail -50" })).toBe(null);
        expect(evaluateGuardrails("shell", { command: "node src/app.js" })).toBe(null);
        expect(evaluateGuardrails("shell", { command: "findstr /i todo src\\*.js" })).toBe(null);
    });

    it("runCommand 的 args 数组也会拼起来检查", () => {
        expect(evaluateGuardrails("runCommand", { command: "rm", args: ["-rf", "/tmp/x"] })?.id).toBe("dangerous-runCommand");
        expect(evaluateGuardrails("runCommand", { command: "npm", args: ["test"] })).toBe(null);
    });
});

describe("C1 护栏：单个写入正文过大 → 拒绝", () => {
    it("超过上限拒绝，恰好等于上限放行", () => {
        const big = "x".repeat(MAX_SINGLE_WRITE_BYTES + 1);
        expect(evaluateGuardrails("writeFile", { path: "a.ts", content: big })?.id).toBe("oversized-write");
        const ok = "x".repeat(MAX_SINGLE_WRITE_BYTES);
        expect(evaluateGuardrails("writeFile", { path: "a.ts", content: ok })).toBe(null);
    });
});

describe("C1 护栏：一次铺太多文件 → 整批拒绝（治「一次生成整个后端目录」）", () => {
    it("写操作条数超上限即拒；恰好等于上限放行", () => {
        const many = Array.from({ length: MAX_WRITES_PER_BATCH + 1 }, () => ({ tool: "writeFile" }));
        expect(evaluateWriteBatch(many)?.id).toBe("write-batch-limit");
        expect(evaluateWriteBatch(many.slice(1))).toBe(null);
    });

    it("只读工具不计入写操作", () => {
        const reads = Array.from({ length: 20 }, () => ({ tool: "readFile" }));
        expect(evaluateWriteBatch(reads)).toBe(null);
    });

    it("读写混合只数写（3 写 + 9 读 = 放行）", () => {
        const mixed = [
            ...Array.from({ length: 3 }, () => ({ tool: "writeFile" })),
            ...Array.from({ length: 9 }, () => ({ tool: "readFile" })),
        ];
        expect(evaluateWriteBatch(mixed)).toBe(null);
    });

    it("mkdir / editFile 也算写操作（三件套一致）", () => {
        const writes = [
            { tool: "mkdir" }, { tool: "mkdir" }, { tool: "editFile" },
            { tool: "editFile" }, { tool: "writeFile" }, { tool: "writeFile" }, { tool: "writeFile" },
        ];
        expect(evaluateWriteBatch(writes)?.id).toBe("write-batch-limit");
    });
});

describe("C1 护栏：单调性（命中即拒，无 allow 能覆盖）", () => {
    it("规则按序求值、命中即裁定——表里再宽的规则也盖不掉前面的 deny", () => {
        const v = evaluateGuardrails("shell", { command: "rm -rf /" }, DEFAULT_GUARDRAILS);
        expect(v).not.toBe(null);
        expect(v?.id).toBe("dangerous-shell");
        // 追加一条"放行一切"的规则，也改变不了命中结果（单调：只 deny，不 allow）
        const withAllow = [
            ...DEFAULT_GUARDRAILS,
            { id: "allow-all", tool: "*", reason: "放行" } as unknown as (typeof DEFAULT_GUARDRAILS)[number],
        ];
        expect(evaluateGuardrails("shell", { command: "rm -rf /" }, withAllow)?.id).toBe("dangerous-shell");
    });
});
