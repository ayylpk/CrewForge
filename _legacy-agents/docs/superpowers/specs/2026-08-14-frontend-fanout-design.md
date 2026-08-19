# Frontend Fan-Out Design

## Goal

Reduce the input and output size of frontend LLM calls by splitting each frontend parent task into file-scoped subtasks, while preserving the existing project pipeline and the merger/test contract.

## Existing Boundary

The current frontend stage receives one `ExecTask`, runs a structure worker followed by a logic worker, writes all returned files, and sends one `task_result` to `merger`. `merger` expects one backend result and one frontend result per interface pair. Backend, merger, test, maintainer, and the external message protocol should remain unchanged.

## Design

`runFrontend` becomes a coordinator with three internal queues and workers:

```text
frontend parent task
    -> deterministic file splitter
       -> view queue
       -> API/support queue
       -> route queue
    -> parallel file-scoped workers
    -> parent-task aggregation
    -> one task_result to merger
```

Each subtask owns exactly one file. File classification is deterministic: router paths go to the route worker; API/service paths go to the API worker; page/view/component files go to the view worker; remaining files go to the support worker. The route worker is single-threaded within a frontend coordinator so shared router files are not concurrently written.

View files continue through structure then logic, but each LLM request receives only one component file. API, route, and support files use a focused implementation prompt and one file-scoped response. Every worker writes only its assigned path and reports completion to the coordinator.

The coordinator tracks a run id for every parent task. It sends success to `merger` only when every subtask succeeds. A single subtask failure sends one parent failure result and invalidates late results from that run. A later test revision creates a new run for the same parent task id.

## Non-Goals

- No changes to backend execution, merger pairing, test judgement, maintainer convergence, or LLM transport.
- No new LLM decomposition call; splitting uses file paths and existing task metadata.
- No concurrent writes to a shared route file.

## Acceptance Criteria

1. A frontend task with `TaskCreate.vue`, `taskCreate.ts`, and `router/index.ts` produces three file-scoped subtasks with the same parent id.
2. Each subtask contains exactly one output file and no unrelated file path.
3. View, API/support, and route workers can process independent subtasks concurrently.
4. The parent emits exactly one successful merger result after all subtasks succeed.
5. A failed subtask causes one parent failure result; late results from the invalidated run cannot emit success.
6. A second run for the same parent task id is isolated from the first run.
7. Node build and the frontend splitter/aggregator tests pass.

