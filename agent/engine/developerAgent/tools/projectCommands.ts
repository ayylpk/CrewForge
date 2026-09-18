// tools/projectCommands.ts —— 「按工程文件识别构建命令」的唯一真相
//
//   9/13 实弹教训：graph.ts 的本地自检把后端构建写死成 mvnw.cmd（Java 假设），
//   Express/TypeScript 项目因此被"证据为空的 COMPILE 失败"拖进修复死循环烧光预算。
//   引擎不能把某一种技术栈当成全世界唯一答案。
//
//   本文件只做一件事：给一个目录，按**工程文件**（不是框架名、不是 LLM）解析出
//   构建命令。识别不了就返回 null——由调用方如实转成 NO_BUILD_ENTRY：
//   未验证，不是通过，也不是编译错误，更不猜命令。
//
//   迁移说明：原实现是 architectTaskBuilder.ts 的 resolveGenericCommand。
//   developerAgent 要能整块替换，不能反向 import 上层，故搬进来；
//   architectTaskBuilder 保留同名导出（live/verifier.ts 等下游无感）。
import fs from "node:fs";
import path from "node:path";

/** 结构化错误码：目录存在但没有可识别的通用工程入口 */
export const NO_BUILD_ENTRY = "NO_BUILD_ENTRY" as const;

export interface ResolvedProjectCommand {
    command: string;
    args: string[];
    /** 依据哪个工程文件解析出来的（写进日志与证据，便于审计） */
    detectedBy: string;
}

const IS_WIN = process.platform === "win32";

/**
 * 识别顺序（工程文件，不是框架）：
 *   1. mvnw.cmd（Windows Maven Wrapper）  2. mvnw（Unix）
 *   3. gradlew.bat                        4. gradlew
 *   5. package.json 的 scripts.build / scripts.compile（**只有这两个**——
 *      dev/start/test 不是构建命令，绝不自动执行任意脚本）
 *   6. pyproject.toml / requirements.txt → python -m compileall -q .
 *   7. go.mod → go build ./...
 * 全部落空 → null（不猜）。
 */
export function resolveProjectCommand(
    dirAbs: string, o: { isWin?: boolean } = {},
): ResolvedProjectCommand | null {
    const win = o.isWin ?? IS_WIN;
    const has = (f: string): boolean => { try { return fs.existsSync(path.join(dirAbs, f)); } catch { return false; } };

    const mvnw = win ? "mvnw.cmd" : "mvnw";
    if (has(mvnw)) return { command: mvnw, args: ["-q", "package", "-DskipTests"], detectedBy: "maven-wrapper" };
    if (has("mvnw")) return { command: "mvnw", args: ["-q", "package", "-DskipTests"], detectedBy: "maven-wrapper" };

    const gradlew = win ? "gradlew.bat" : "gradlew";
    if (has(gradlew)) return { command: gradlew, args: ["build", "-x", "test"], detectedBy: "gradle-wrapper" };
    if (has("gradlew")) return { command: "gradlew", args: ["build", "-x", "test"], detectedBy: "gradle-wrapper" };

    if (has("package.json")) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(dirAbs, "package.json"), "utf-8")) as { scripts?: Record<string, string> };
            const scripts = pkg.scripts ?? {};
            const script = scripts["build"] ? "build" : scripts["compile"] ? "compile" : null;
            // 注意：package.json 存在但没有 build/compile 脚本 → 继续往下找别的工程文件，
            // 最后仍一无所获才返回 null——绝不退回"猜一个 npm run build"。
            if (script) return { command: "npm", args: ["run", script], detectedBy: `package.json.scripts.${script}` };
        } catch { /* package.json 坏了不算识别成功 */ }
    }

    if (has("pyproject.toml") || has("requirements.txt")) {
        return { command: "python", args: ["-m", "compileall", "-q", "."], detectedBy: "python-project" };
    }

    if (has("go.mod")) return { command: "go", args: ["build", "./..."], detectedBy: "go-module" };

    return null;
}
