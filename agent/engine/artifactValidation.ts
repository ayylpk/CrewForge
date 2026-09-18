// artifactValidation.ts —— 任务级产物与项目级基线校验（纯确定性逻辑）
import type { ExecTask } from "./common";
import type { ProjectBaseline } from "./baseline";
import { checkFile, type GateKnown } from "./checkers";
import { classifyFailure, type FailureCategory } from "./qualityMetrics";

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
  /** 便于经理看板/回放集统计；旧证据没有此字段时按 unknown 兼容。 */
  failureCategory?: FailureCategory | null;
}

export interface ValidationResult {
  passed: boolean;
  issues: string[];
}

export type ArtifactWriter = (filePath: string, content: string) => Promise<unknown> | unknown;

/** 任务提交顺序：先全部代码文件，再证据文件；调用方可注入事务化/持久化 writer。 */
export async function persistTaskArtifacts(
  task: ExecTask,
  files: { filePath: string; code: string }[],
  evidence: TaskEvidence,
  writer: ArtifactWriter,
): Promise<void> {
  const allowed = new Set(task.files.map((file) => file.replace(/\\/g, "/")));
  for (const file of files) {
    const normalized = file.filePath.replace(/\\/g, "/");
    if (!allowed.has(normalized)) throw new Error(`任务 ${task.id} 无权写入 ${normalized}`);
    await writer(normalized, file.code);
  }
  await writer(`_task-evidence/${task.phase ?? 0}-${task.id}.json`, JSON.stringify(evidence, null, 2));
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
    failureCategory: result.passed ? null : classifyFailure(result.issues.join("；")),
  };
}
