# Frontend Fan-Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split frontend parent tasks into file-scoped parallel workers and aggregate them back into the existing merger contract.

**Architecture:** Keep the existing manager -> architect -> developer -> merger -> test -> maintainer pipeline. Add a deterministic splitter, three internal frontend queues, file-scoped workers, and a parent-run aggregator inside `frontendEngineer.ts`; the merger receives exactly one result for each original frontend task.

**Tech Stack:** TypeScript, Bun build targeting Node.js, existing `WorkQueue`, `TransferStation`, LangChain structured JSON output, Node `assert/strict` verification script.

## Global Constraints

- Do not change the LLM transport, timeout, semaphore, backend worker, merger protocol, test protocol, or maintainer protocol.
- Each frontend subtask owns exactly one file.
- The route worker must serialize route-file writes.
- A parent task emits at most one result per run.
- Existing user changes and untracked reproduction scripts must remain untouched.

---

### Task 1: Add splitter and aggregation tests

**Files:**
- Create: `verify-frontend-split.ts`
- Modify: `package.json`
- Test: `verify-frontend-split.ts`

**Interfaces:**
- Consumes: exported `classifyFrontendFile`, `splitFrontendTask`, `FrontendRunCoordinator` from `frontendEngineer.ts`.
- Produces: executable assertions for classification, one-file subtasks, all-success convergence, failure invalidation, late-result isolation, and retry-run isolation.

- [x] **Step 1: Add a test script**

Add `"verify:frontend-split": "bun verify-frontend-split.ts"` to `package.json`.

- [x] **Step 2: Write the failing test**

Create a test task with `src/views/TaskCreate.vue`, `src/api/taskCreate.ts`, and `src/router/index.ts`. Assert the splitter returns three subtasks with kinds `view`, `api`, and `route`, each with one file and the same parent id. Assert the coordinator returns `pending` until all three subtask ids succeed, then returns `success` exactly once. Assert a failed result returns `failure`, late results return `ignored`, and starting a new run with the same parent id is independent.

- [x] **Step 3: Run the test and verify the expected failure**

Run: `bun run verify:frontend-split`

Expected: fail because the splitter and coordinator exports do not exist yet.

### Task 2: Implement deterministic frontend fan-out primitives

**Files:**
- Modify: `frontendEngineer.ts`
- Test: `verify-frontend-split.ts`

**Interfaces:**
- Consumes: existing `ExecTask` shape.
- Produces: `FrontendSubtask`, `classifyFrontendFile`, `splitFrontendTask`, and `FrontendRunCoordinator`.

- [x] **Step 1: Implement file classification**

Classify router paths before all other rules, then API/service paths, then view/component paths, and finally support files. Normalize slash direction and casing. Keep classification pure and deterministic.

- [x] **Step 2: Implement one-file subtask creation**

Clone the parent task for each file, replace `files` with a single path, add the subtask kind to its description, and assign a stable subtask id derived from the parent id and file index. Preserve the parent task object separately for merger delivery.

- [x] **Step 3: Implement run tracking**

Track active run ids by parent task id. `recordSuccess` returns `pending` until all expected subtasks succeed, then returns `success` once. `recordFailure` invalidates the run and returns `failure` once. Results from inactive or unknown runs return `ignored`.

- [x] **Step 4: Run the test and verify it passes**

Run: `bun run verify:frontend-split`

Expected: all splitter and coordinator assertions pass.

### Task 3: Add focused frontend workers and aggregation

**Files:**
- Modify: `frontendEngineer.ts`
- Test: `verify-frontend-split.ts`

**Interfaces:**
- Consumes: `FrontendSubtask`, `FrontendRunCoordinator`, existing `contentModel`, `llmWithTimeout`, and `TransferStation`.
- Produces: view, API/support, and serialized route queues; one parent-level `task_result` message after aggregation.

- [x] **Step 1: Add the three queues**

Create view, API/support, and route queues. Route processing has one worker. Keep all writes inside the coordinator so stale runs cannot write after invalidation.

- [x] **Step 2: Add file-scoped prompts**

Keep the existing two-stage view behavior but pass one view file per request. Add a focused implementation prompt for API, route, and support files that requires one exact `filePath`, complete code, existing-file preservation, and no unrelated files.

- [x] **Step 3: Implement worker completion handling**

Write only the assigned file, record the subtask result, and ignore late results from invalidated runs. On aggregate success, send the original parent task once to `merger`; on aggregate failure, send the original parent task once with `success: false`.

- [x] **Step 4: Preserve revision handling**

When a test revision arrives, start a new run for the revised parent task. Do not allow late output from the previous run to complete the revised run.

### Task 4: Verify integration and runtime behavior

**Files:**
- Modify: `frontendEngineer.ts` only if integration verification exposes a defect.
- Test: existing `verify:frontend-split`, Node build, and a small smoke run.

**Interfaces:**
- Consumes: all completed frontend fan-out behavior.
- Produces: evidence that the existing merger receives one parent result and that the project still builds.

- [x] **Step 1: Run the focused tests**

Run: `bun run verify:frontend-split`

Expected: exit code 0 and all assertions pass.

- [x] **Step 2: Build the Node production entry**

Run: `bun run build:node`

Expected: exit code 0 and a generated `dist-node/start.mjs`.

- [x] **Step 3: Run a minimal smoke test with automatic confirmation**

Run one small real-API run with `AUTO_CONFIRM=1`. Inspect logs for separate subtask labels, parent aggregation, and exactly one merger delivery per frontend parent task. Stop the process if a request exceeds the existing application timeout or if the process remains idle without a new gate log.

Observed outcome: the splitter created `T1-F-part-1` and the backend completed, but the page-structure request emitted its call log and did not return before the smoke process was stopped. This smoke run is not a passing end-to-end result.

- [x] **Step 4: Re-read acceptance criteria**

Confirm each design acceptance criterion against test output, build output, and smoke logs. Report any criterion not exercised rather than claiming full completion.

Current gap: real-API behavior of a single page request remains unresolved and requires a separate transport/runtime investigation.
