import fs from 'fs/promises';
import path from 'path';

/** 检测到的项目上下文 */
export interface ProjectContext {
  projectName: string;
  /** JS: npm/pnpm/bun/yarn；Java: maven/gradle（9/4 伤③扩展） */
  packageManager: string;
  testCommand: string;
  hasTypeScript: boolean;
  framework: string;
  cwd: string;
  /** 检出到的额外提示（如 Maven 多模块），会拼进 system prompt */
  notes?: string;
}

/** 路径存在性探测（lock 文件 / pom.xml / gradlew 通用） */
const exists = async (file: string) => {
  try { await fs.access(file); return true; } catch { return false; }
};

/**
 * 自动检测当前项目的上下文信息
 *
 * 9/4 伤③修复：旧版只认 package.json——Java 项目（testAgent 的头号
 * 服务对象就是 CrewForge 交付终检）检出失灵，testCommand 会错报成 npm test。
 * 现在按 package.json → pom.xml → build.gradle 三路线检出，全都没有则显式置空，
 * 让调用方（index.ts --auto）fail-fast，而不是拿着假命令硬跑。
 */
export async function detectContext(): Promise<ProjectContext> {
  const cwd = process.cwd();
  const ctx: ProjectContext = {
    projectName: path.basename(cwd),
    packageManager: '',
    testCommand: '',
    hasTypeScript: false,
    framework: 'unknown',
    cwd,
  };

  // —— 路线 A：JS/TS 项目（原有逻辑）——
  let hasPackageJson = false;
  try {
    const pkgRaw = await fs.readFile(path.join(cwd, 'package.json'), 'utf-8');
    hasPackageJson = true;
    const pkg = JSON.parse(pkgRaw);

    ctx.projectName = pkg.name || ctx.projectName;
    ctx.packageManager = 'npm';
    ctx.testCommand = 'npm test';

    // 检测包管理器：看 lock 文件
    if (await exists(path.join(cwd, 'pnpm-lock.yaml'))) ctx.packageManager = 'pnpm';
    else if (await exists(path.join(cwd, 'bun.lock'))) ctx.packageManager = 'bun';
    else if (await exists(path.join(cwd, 'bun.lockb'))) ctx.packageManager = 'bun';
    else if (await exists(path.join(cwd, 'yarn.lock'))) ctx.packageManager = 'yarn';

    // 检测测试框架
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (allDeps?.vitest) ctx.testCommand = `${ctx.packageManager} vitest run`;
    else if (allDeps?.jest) ctx.testCommand = `${ctx.packageManager} test`;
    else if (allDeps?.mocha) ctx.testCommand = `${ctx.packageManager} test`;
    if (pkg.scripts?.test) {
      // lock 缺失兜底（9/4 eval f3 暴露）：bun install 对零依赖项目不写 bun.lock，
      // 此时 scripts.test 的首词（bun/pnpm/yarn test）比 lock 存在性更权威
      const lead = String(pkg.scripts.test).trim().split(/\s+/)[0] ?? '';
      if (ctx.packageManager === 'npm' && ['bun', 'pnpm', 'yarn'].includes(lead)) {
        ctx.packageManager = lead;
      }
      ctx.testCommand = `${ctx.packageManager} test`;
    }

    // 检测框架
    if (allDeps?.vue || allDeps?.['vue-router']) ctx.framework = 'Vue';
    else if (allDeps?.react || allDeps?.['react-dom']) ctx.framework = 'React';
    else if (allDeps?.next) ctx.framework = 'Next.js';
    else if (allDeps?.nuxt) ctx.framework = 'Nuxt';
    else if (allDeps?.express) ctx.framework = 'Express';
    else if (Object.keys(allDeps || {}).length > 0) ctx.framework = 'Node.js';
  } catch { /* 无 package.json，走下面的 Java 路线 */ }

  // —— 路线 B/C：Java 项目（9/4 伤③新增）——
  // Git Bash 下 mvnw/gradlew 是 shell 脚本，写 ./mvnw 可执行
  if (!hasPackageJson) {
    if (await exists(path.join(cwd, 'pom.xml'))) {
      ctx.packageManager = 'maven';
      ctx.testCommand = (await exists(path.join(cwd, 'mvnw'))) ? './mvnw test' : 'mvn test';
      ctx.framework = 'Java';
      try {
        const pom = await fs.readFile(path.join(cwd, 'pom.xml'), 'utf-8');
        if (pom.includes('spring-boot')) ctx.framework = 'Spring Boot';
        if (pom.includes('<modules>')) {
          ctx.notes = 'Maven 多模块项目：testCommand 在根目录跑全量；只修单个模块可用 "mvn test -pl <模块名> -am"；Maven 报错大多在 stdout，搜 BUILD FAILURE 附近的堆栈';
        }
      } catch { /* pom 读不动也不影响命令检出 */ }
    } else if ((await exists(path.join(cwd, 'build.gradle'))) || (await exists(path.join(cwd, 'build.gradle.kts')))) {
      ctx.packageManager = 'gradle';
      ctx.testCommand = (await exists(path.join(cwd, 'gradlew'))) ? './gradlew test' : 'gradle test';
      ctx.framework = 'Java (Gradle)';
    }
  }

  // 什么都没检出：保持空 testCommand + 提示，由 index.ts 决定 fail-fast
  if (!ctx.testCommand) {
    ctx.notes = '未检出 package.json / pom.xml / build.gradle，无法自动确定测试命令——请先向用户确认，不要盲目执行';
  }

  // 检测 TypeScript
  try {
    await fs.access(path.join(cwd, 'tsconfig.json'));
    ctx.hasTypeScript = true;
  } catch { /* 无 tsconfig */ }

  return ctx;
}

/** 将上下文格式化为字符串，注入 system prompt */
export function formatContext(ctx: ProjectContext): string {
  return [
    `📁 项目: ${ctx.projectName}`,
    `📍 目录: ${ctx.cwd}`,
    `📦 构建工具: ${ctx.packageManager || '未检出'}`,
    `🧪 测试命令: ${ctx.testCommand || '未检出'}`,
    `🔤 TypeScript: ${ctx.hasTypeScript ? '是' : '否'}`,
    `🖼 框架: ${ctx.framework}`,
    ctx.notes ? `📌 ${ctx.notes}` : null,
  ].filter(Boolean).join('\n');
}

// ============================================================
// 专修模式（CrewForge engine2 第十二步）：输入 / 输出契约 + 路径权限
//
//   定位：CrewForge 的编排器（engine2）在有**机器证据**的失败时把"修什么"交给本 agent，
//   但**能不能改**由这里的纯函数机械判定——不靠模型自觉。
//   铁律：
//     · 只能改 allowedRoots 内的文件
//     · 不能改项目目录之外的任何东西（含 CrewForge 源码与本 agent 自身）
//     · 不能改 .git
//     · 结论必须来自"重新执行原命令的退出码"，不是模型的自我评价
// ============================================================

/** 与 CrewForge engine2/types.ts 的 Evidence 同形（此处独立声明，避免跨仓耦合） */
export interface Evidence {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  artifacts: string[];
}

/** 输入契约 */
export interface RepairRequest {
  /** 被修的项目根目录（生成物所在处） */
  projectDir: string;
  /** 允许修改的根（相对 projectDir 或绝对路径）；空数组 = 一律不许改 */
  allowedRoots: string[];
  /** 失败命令（原样重跑，用于判定是否修好） */
  command: string;
  args: string[];
  /** 失败证据（命令 + 退出码 + stdout/stderr 原文） */
  evidence: Evidence;
  /** 迭代上限；耗尽返回 incomplete */
  maxIterations: number;
}

/** 输出契约 */
export interface RepairResult {
  verdict: "changed" | "unchanged" | "incomplete" | "error";
  changedFiles: string[];
  patchFile: string | null;
  iterations: number;
  remainingIssues: string[];
}

export interface PathDecision { ok: boolean; reason: string; abs: string }

function normalize(p: string): string {
  const abs = path.resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/** 是否在某个根之内（根可以是目录前缀，也可以是单个文件） */
export function isUnder(abs: string, root: string): boolean {
  const a = normalize(abs);
  const r = normalize(root);
  if (a === r) return true;
  return a.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/**
 * 专修模式的路径闸门（纯函数，可单测）。
 * 顺序：非空 → 项目内 → 非 .git → 命中 allowedRoots。
 */
export function isRepairPathAllowed(target: string, allowedRoots: string[], projectDir: string): PathDecision {
  const raw = (target ?? '').trim();
  if (!raw) return { ok: false, reason: '路径为空', abs: '' };
  const abs = path.resolve(projectDir, raw);
  const projAbs = path.resolve(projectDir);

  if (!isUnder(abs, projAbs)) {
    return { ok: false, reason: '拒绝：超出项目目录（不许改 CrewForge 源码、不许改本 agent 自身）', abs };
  }
  if (normalize(abs) === normalize(projAbs)) {
    return { ok: false, reason: '拒绝：目标是项目根目录本身', abs };
  }
  if (isUnder(abs, path.join(projAbs, '.git'))) {
    return { ok: false, reason: '拒绝：不许改 .git', abs };
  }
  const roots = (allowedRoots ?? []).map(r => (path.isAbsolute(r) ? r : path.resolve(projAbs, r)));
  if (roots.length === 0) {
    return { ok: false, reason: '拒绝：allowedRoots 为空，专修模式一律不许改文件', abs };
  }
  if (!roots.some(r => isUnder(abs, r))) {
    return { ok: false, reason: `拒绝：不在 allowedRoots 内（${roots.map(r => path.relative(projAbs, r) || '.').join(', ')}）`, abs };
  }
  return { ok: true, reason: '允许', abs };
}

const WRITE_TOKENS = [/(^|\s)>{1,2}\s*\S/, /\btee\b/, /\bsed\s+-i/, /(^|\s)rm\s/, /(^|\s)mv\s/, /(^|\s)cp\s/, /(^|\s)(del|rd|rmdir|mkdir|touch|truncate)\s/i, /\bset-content\b/i];

/**
 * bash 工具的"best-effort"写盘闸（诚实标注其边界）：
 *   机械闸门是 edit/write 的 isRepairPathAllowed；bash 无法做语义级证明，
 *   这里只拦"明显的写文件命令 + 目标落在 allowedRoots 之外"这一形态。
 */
export function isRepairBashAllowed(command: string, allowedRoots: string[], projectDir: string): PathDecision {
  const cmd = command ?? '';
  if (!WRITE_TOKENS.some(re => re.test(cmd))) return { ok: true, reason: '非写盘命令', abs: '' };
  const projAbs = path.resolve(projectDir);
  const tokens = cmd.match(/(?:\/\/[^\s"']+|[A-Za-z]:[\\/][^\s"']+|\/[\w.\-/]+|[\w.\-/\\]+\.[A-Za-z0-9]{1,6})/g) ?? [];
  for (const t of tokens) {
    if (!/[\\/]/.test(t)) continue;
    const decision = isRepairPathAllowed(t, allowedRoots, projAbs);
    if (!decision.ok && /超出项目目录|不在 allowedRoots|不许改 \.git/.test(decision.reason)) {
      return { ok: false, reason: `拒绝写盘命令：目标 ${t} —— ${decision.reason}`, abs: decision.abs };
    }
  }
  return { ok: true, reason: '写盘目标都在 allowedRoots 内（或未检出项目外路径）', abs: '' };
}
