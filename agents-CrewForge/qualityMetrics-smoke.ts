import { classifyFailure, aggregateTaskEvidence } from "./qualityMetrics";
import type { TaskEvidence } from "./artifactValidation";

const evidence = (taskId: string, passed: boolean, retryCount: number, failureReason: string | null): TaskEvidence => ({
  taskId,
  phase: 1,
  checks: [{ item: "gate", verdict: passed ? "pass" : "fail", evidence: passed ? "ok" : failureReason ?? "failed" }],
  commands: [],
  outputSummary: passed ? "passed" : "failed",
  failureReason,
  retryCount,
});

const rows = [
  evidence("T1", true, 0, null),
  evidence("T2", false, 1, "frontend/src/views/A.vue：import ../utils/request.ts 不存在；候选为 frontend/src/utils/request.ts"),
  evidence("T3", false, 2, "POST /api/items 前端调用与 Spring @PostMapping 路由不一致"),
];
const metrics = aggregateTaskEvidence(rows);
const checks: [string, boolean][] = [
  ["classifies ghost import", classifyFailure(rows[1]!.failureReason!) === "import_contract"],
  ["classifies api mismatch", classifyFailure(rows[2]!.failureReason!) === "api_contract"],
  ["counts pass and fail", metrics.total === 3 && metrics.passed === 1 && metrics.failed === 2],
  ["calculates first pass rate", metrics.firstPassRate === 1 / 3],
  ["counts retries", metrics.totalRetries === 3],
  ["sorts failure categories", metrics.failuresByCategory.import_contract === 1 && metrics.failuresByCategory.api_contract === 1],
];
let failed = 0;
for (const [name, ok] of checks) { console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) failed++; }
console.log(`Quality metrics smoke: ${checks.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
