// message-protocol-smoke.ts —— 消息协议确定性冒烟（零 LLM、零 DB）
import {
  MessageEnvelopeSchema,
  PhasePlanMessageSchema,
  PhaseRequestMessageSchema,
  PhaseDoneMessageSchema,
  TaskMessageSchema,
  TaskResultMessageSchema,
  PairReadyMessageSchema,
  parseMessageEnvelope,
} from "./messageProtocol";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean): void {
  if (condition) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.error(`FAIL ${name}`); }
}

check("valid phase_plan", PhasePlanMessageSchema.safeParse({
  type: "phase_plan", projectId: 1, phase: { phase: 1, name: "foundation" }, plan: { phases: [] },
}).success);
check("rejects phase_plan without project", !PhasePlanMessageSchema.safeParse({
  type: "phase_plan", phase: { phase: 1, name: "foundation" }, plan: { phases: [] },
}).success);
const task = { id: "t1", layer: "backend", method: "GET", path: "/api/items", files: ["src/Items.java"], title: "API", description: "list items", parameters: [], acceptance: "returns data" };
check("valid task", TaskMessageSchema.safeParse({ type: "task", task }).success);
check("rejects malformed task_result", !TaskResultMessageSchema.safeParse({ type: "task_result", task, success: "yes" }).success);
check("valid pair_ready", PairReadyMessageSchema.safeParse({
  type: "pair_ready", phase: 1, pair: { back: task, front: { ...task, id: "f1", layer: "frontend" } },
}).success);
check("valid phase_done", PhaseDoneMessageSchema.safeParse({ type: "phase_done", phase: 1, failed: [] }).success);
check("valid phase_request", PhaseRequestMessageSchema.safeParse({ type: "phase_request", phase: 2 }).success);
check("envelope parses JSON and preserves sender", parseMessageEnvelope("architect", "manager", JSON.stringify({ type: "phase_request", phase: 2 }))?.sender === "architect");
check("envelope rejects unknown message", parseMessageEnvelope("x", "y", JSON.stringify({ type: "unknown" })) === null);
check("envelope schema has sender and receiver", MessageEnvelopeSchema.safeParse({ sender: "a", receiver: "b", content: "{}" }).success);

console.log(`Message protocol smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
