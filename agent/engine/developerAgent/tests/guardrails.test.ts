// tests/guardrails.test.ts —— C1 代码级护栏（默认拒绝 + 单调 deny）
//
//   铁律：这些"禁止"必须由**代码**拦下，不能寄望提示词——
//   `skills/backend-development.md` 的"禁止一次生成整个后端目录"写在提示词里被无视过（p7 llm#16）。
import { describe, expect, it } from "bun:test";
import {
    DEFAULT_GUARDRAILS, MAX_SINGLE_WRITE_BYTES, MAX_WRITES_PER_BATCH,
    evaluateGuardrails, evaluateWriteBatch, matchDangerous,
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

    // ★ 9/18 回归（实测误伤）：原正则 `\b(format|mkfs|diskpart)\b` 里，`\b` 在 "Format-Table"
    //   的 t 与 - 之间成立，于是 PowerShell 的格式化 cmdlet 被判成"格式化/分区命令"。
    //   现场代价：s1 那轮 19 分钟里 guardrail_denied 连开 9 枪，agent 换写法重试→又中→再换，
    //   后半程预算几乎全耗在这个死循环上。下面这几条必须放行。
    it("★ PowerShell 的 Format-* cmdlet / docker --format 不再误判为格式化命令", () => {
        const 放行 = [
            'powershell -Command "Get-ChildItem | Format-Table -AutoSize"',
            "powershell -NoProfile -Command $o=@(); $o+=(Get-Service | Format-List Name)",
            'powershell -Command "docker ps --format {{.Names}}"',
            "curl -sS -o NUL -w format=%{http_code} https://example.com",
        ];
        for (const cmd of 放行) {
            expect(matchDangerous(cmd)).toBe(null);
            expect(evaluateGuardrails("shell", { command: cmd })).toBe(null);
        }
        // 真格式化照拦（不能因为修误伤把真危险也放了）
        for (const cmd of [
            "format C:", "format.com /q D:", "format /q", "format", "mkfs.ext4 /dev/sda1", "diskpart",
            "mkdir build & format D: /q",          // 命令段中间也算
        ]) {
            expect(evaluateGuardrails("shell", { command: cmd })?.id).toBe("dangerous-shell");
        }
    });

    it("★ 拒绝理由要说清「命中哪条」，否则验尸只能靠猜", () => {
        const v = evaluateGuardrails("shell", { command: 'Get-Service x | Format-Table -AutoSize' });
        expect(v).toBe(null);                       // cmdlet 放行，自然没有理由
        const denied = evaluateGuardrails("shell", { command: "format D: /q" })!;
        expect(denied.reason).toContain("命中");
        expect(denied.reason).toContain("格式化命令（format）");
        expect(matchDangerous("del /s /q build")).toContain("递归静默删除");
        expect(matchDangerous("rm -rf /")).toContain("递归强制删除");
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
