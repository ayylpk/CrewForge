// artifactValidation.ts —— 任务级产物与项目级基线校验（纯确定性逻辑）
import type { ExecTask } from "./common";
import type { ProjectBaseline } from "./baseline";
import { checkFile, type GateKnown } from "./checkers";

export interface TaskEvidenceCheck {
  item: string;
  verdict: "pass" | "fail" | "skip";
  evidence: string;
}

export interface TaskEvidence {
  taskId: string;
  phase: number | null;
  checks: TaskEvidenceCheck[];
  commands: { command: string; outputSummary: string; exitCode: number | null }[];
  outputSummary: string;
  failureReason: string | null;
  retryCount: number;
}

export interface ValidationResult {
  passed: boolean;
  issues: string[];
}

export async function validateTaskArtifact(task: ExecTask, workspace: GateKnown): Promise<ValidationResult> {
  const issues: string[] = [];
  for (const file of task.files) {
    if (!workspace.has(file)) {
      issues.push(`任务 ${task.id} 缺少产物：${file}`);
      continue;
    }
    const content = workspace.read(file);
    if (content == null) continue;
    const problems = await checkFile(file, content, workspace);
    issues.push(...problems.map((p) => `${file}：${p}`));
  }
  return { passed: issues.length === 0, issues };
}

export function validateWorkspace(workspace: GateKnown, baseline: ProjectBaseline): ValidationResult {
  const issues: string[] = [];
  if (baseline.frontend.enabled && !workspace.has(baseline.frontend.requestPath)) {
    issues.push(`缺少统一请求封装：${baseline.frontend.requestPath}`);
  }
  if (baseline.backend.enabled && !workspace.list().some((file) => /(^|\/)pom\.xml$|build\.gradle(?:\.kts)?$/i.test(file))) {
    // A project may use a non-Java stack; only enforce a build manifest for the selected backend family.
    if (/spring boot|java/i.test(baseline.backend.framework + " " + baseline.backend.language)) {
      issues.push("后端缺少 pom.xml 或 Gradle 构建文件");
    }
  }
  return { passed: issues.length === 0, issues };
}

export function evidenceForTask(task: ExecTask, result: ValidationResult, retryCount = 0): TaskEvidence {
  return {
    taskId: task.id,
    phase: task.phase ?? null,
    checks: [{ item: "任务产物校验", verdict: result.passed ? "pass" : "fail", evidence: result.passed ? "文件存在且机械校验通过" : result.issues.join("；") }],
    commands: [],
    outputSummary: result.passed ? "task artifact validation passed" : "task artifact validation failed",
    failureReason: result.passed ? null : result.issues.join("；"),
    retryCount,
  };
}
