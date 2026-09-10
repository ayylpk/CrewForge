import { resolveProjectBaseline } from "./baseline";
import { buildKnown } from "./checkers";
import { validateTaskArtifact, validateWorkspace, type TaskEvidence } from "./artifactValidation";

const task = {
  id: "T1", layer: "frontend" as const, method: "GET", path: "/api/items", files: ["frontend/src/views/Items.vue"],
  title: "items", description: "list", parameters: [], acceptance: "shows items", phase: 1,
};
const valid = buildKnown(null, new Map([
  ["frontend/src/views/Items.vue", "<template><div>items</div></template>"],
  ["frontend/src/utils/request.ts", "export default {};"],
  ["backend/pom.xml", "<project/>"]
]), []);
const missing = buildKnown(null, new Map(), []);
const evidence: TaskEvidence = {
  taskId: "T1", phase: 1, checks: [{ item: "files", verdict: "pass", evidence: "Items.vue exists" }],
  commands: [], outputSummary: "mechanical checks passed", failureReason: null, retryCount: 0,
};

const artifact = await validateTaskArtifact(task, valid);
const missingArtifact = await validateTaskArtifact(task, missing);
const checks: [string, boolean][] = [
  ["valid artifact passes", artifact.passed],
  ["missing artifact fails", !missingArtifact.passed],
  ["evidence is structurally serializable", JSON.parse(JSON.stringify(evidence)).taskId === "T1"],
  ["workspace honors baseline", validateWorkspace(valid, resolveProjectBaseline(null)).passed],
  ["workspace reports missing request wrapper for enabled frontend", !validateWorkspace(missing, resolveProjectBaseline(null)).passed],
];
let failed = 0;
for (const [name, ok] of checks) { console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) failed++; }
console.log(`Artifact validation smoke: ${checks.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
