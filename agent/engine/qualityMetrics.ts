import type { TaskEvidence } from "./artifactValidation";

export const FAILURE_CATEGORIES = [
  "missing_artifact", "import_contract", "api_contract", "compile", "runtime_ui", "dependency", "persistence", "unknown",
] as const;
export type FailureCategory = typeof FAILURE_CATEGORIES[number];

export interface QualityMetrics {
  total: number;
  passed: number;
  failed: number;
  firstPassRate: number;
  totalRetries: number;
  failuresByCategory: Record<FailureCategory, number>;
}

const category = (text: string): FailureCategory => {
  if (/缺少产物|missing artifact|不存在.*文件|file not found/i.test(text)) return "missing_artifact";
  if (/import|导出|export|request\.ts|utils\/request/i.test(text)) return "import_contract";
  if (/api|接口|mapping|路由|endpoint|method|path/i.test(text)) return "api_contract";
  if (/编译|syntax|type.?check|compile|语法/i.test(text)) return "compile";
  if (/白屏|渲染|render|dom|页面/i.test(text)) return "runtime_ui";
  if (/依赖|dependency|package|npm|bun|maven|gradle/i.test(text)) return "dependency";
  if (/落盘|数据库|持久化|database|persist|upsert/i.test(text)) return "persistence";
  return "unknown";
};

export function classifyFailure(reason: string | null | undefined): FailureCategory {
  return reason ? category(reason) : "unknown";
}

function passed(evidence: TaskEvidence): boolean {
  return evidence.failureReason == null && evidence.checks.length > 0 && evidence.checks.every((check) => check.verdict !== "fail");
}

export function aggregateTaskEvidence(evidence: TaskEvidence[]): QualityMetrics {
  const failuresByCategory = Object.fromEntries(FAILURE_CATEGORIES.map((key) => [key, 0])) as Record<FailureCategory, number>;
  let passedCount = 0;
  let firstPassCount = 0;
  let totalRetries = 0;
  for (const item of evidence) {
    totalRetries += Math.max(0, item.retryCount || 0);
    if (passed(item)) {
      passedCount++;
      if (item.retryCount === 0) firstPassCount++;
    } else {
      failuresByCategory[item.failureCategory ?? classifyFailure(item.failureReason)]++;
    }
  }
  return {
    total: evidence.length,
    passed: passedCount,
    failed: evidence.length - passedCount,
    firstPassRate: evidence.length === 0 ? 0 : firstPassCount / evidence.length,
    totalRetries,
    failuresByCategory,
  };
}
