# CrewForge 重写计划：从「多 Agent 消息总线」到「可恢复的软件交付流水线」

> 决策：**推翻架构，不推翻全部代码。**
> 定位：LLM 负责提出和修改方案；程序负责调度、验证、记账和收敛。
> **任何决定"代码是否正确"的事情，都由真实执行结果决定。**
> 日期：2026-09-10　适用对象：`agents-CrewForge` 运行时重写

---

## 1. 定位、铁律与边界

### 1.1 一句话定位

| | 现在 | 重写后 |
|---|---|---|
| 产品叙事 | 虚拟开发团队（多角色聊天） | 可恢复的软件交付流水线 |
| 控制流 | Hub 消息总线 + DB 节点边 | 显式状态机 + 持久化步骤表 |
| 判据 | 正则 + LLM 纸审 | 命令 + 退出码（LLM 只能提议） |
| 骨架/路径 | LLM 自由发明 | 引擎模板直出 + 白名单校验 |
| 恢复 | 内存 Map + 临时 json | Ledger + 内容哈希 + 租约 |

### 1.2 不变量（写进 CI，靠测试强制，不靠自觉）

1. 任何"通过"结论必须可追溯到 **一条命令 + 退出码**；追溯不到即不通过。
2. 机器静态检查**只许 reject，不许 approve**。
3. 进入 Verifier 的字段必须可执行；自然语言只能进 `display*` 字段。
4. 骨架与入口文件归引擎，任务只能写骨架白名单内的路径；越界 = 写盘前机械拒绝。
5. 一个文件同一时刻只有一个 writer。
6. 0 产物 / 0 任务 = 显式失败，**永不 `done`**。
7. 每个 step 幂等且可重放；验证结果按输入哈希缓存。
8. 失败分类只能来自机器信号（退出码 + 错误指纹 + 工具身份），LLM 仅作 tiebreaker。
9. 每 slice / 每 run 都有硬预算；超限即暂停报告，不续烧。

**架构测试两条（自动失败）：**
- `SystemMessage` / `initModels` 只允许出现在 `engine/steps/**` 与 `engine/agents/**`；出现在 `engine/run`、`engine/exec`、`engine/ir`、`engine/workspace` 即测试失败。
- `SliceState.verified` 构造入参类型为 `Evidence`，而 `Evidence` 只能由 `engine/exec` 产出（类型层面堵死"LLM 宣布成功"）。

### 1.3 复用清单（**不要重写**）

| 文件 | 处置 | 去向 |
|---|---|---|
| `runEnv.ts` | 保留 | `engine/workspace/sandbox.ts`（沙箱/路径逃逸防护写得对） |
| `llm.ts` | 保留 | `engine/steps/_retry.ts`（`retryStructured` 反馈式重试骨架） |
| `settings.ts` | 保留 | `engine/config.ts`（配置 + 旁路原则） |
| `checkers.ts` | 保留但**降级** | `engine/exec/static/*`（只许 reject；**必须补 `.java/.xml/.yml/.sql`**） |
| `renderGate.ts` | 保留并升格 | `engine/verify/render.ts`（真开页面判白屏——你们做对的少数几件事之一） |
| `baseline.ts` / `models.ts` | 保留 | `engine/ir/baseline.ts`、`engine/steps/_models.ts`（**档位表要改，见 §7.4**） |
| `concurrency.ts` 概念 | 保留概念 | `engine/run/scheduler.ts`（有界池 + 预算，重写） |

### 1.4 删除清单

| 文件/机制 | 原因 |
|---|---|
| `Hub.ts` / `BaseAgent.ts` | 消息总线当控制平面：未知收件人静默建空箱、first-match-wins 静默丢消息、无持久化、无追踪 |
| `GraphFactory.ts` + `codeRegistry`/`schemaRegistry`/`condRegistry` | 控制流进数据库 |
| `projectRunner.drivePhases` 阶段消息往返 | 改成直接函数调用 |
| `merger.ts` 配对缓存 | 配对是数据结构，不是状态机 |
| `maintainer.ts` 收敛记账 | 并进 Orchestrator |
| `contracts.ts` 的 LLM 生成 md | 改契约 IR + 渲染器 |
| `foundation.pairIntegrationCheck` 的**判决权** | 降为诊断附注（正则只许 reject，且此处连 reject 都不可靠——见 `expectedApisOf` 只认 `- GET /x` 格式，漏检即放行） |
| `sys_agent_node` / `sys_project_agent_node` / `sys_agent_edge` 参与运行 | 表可留作"模板库"，运行时禁止读它当控制流 |

### 1.5 总目标（可验证）

> 冻结 N 个场景项目，端到端跑到"**前端 build 通过 + 后端能启动 + 主流程接口 200 + 页面非白屏 + 需求覆盖清单勾选**"，全程无人干预；
> 失败时输出**显式失败报告**（失败类 + 命令 + 退出码 + 证据），**永不静默 done**。

---

## 2. 模块 A：评测基准（先有尺子）

**依赖**：无。**必须第一个做。**

**为什么第一**：现状是 12 个 smoke 全绿（"28 绿/19 绿"）同时产出质量低——零 LLM 的纯函数测试证明管道不漏水，和产品能不能用零相关。没有尺子，重写完成后你无法证明变好了，也会再次陷入"我觉得变好了"。

**交付物**
```
eval/
  scenarios/{s1,s2,s3}/input.md        冻结的输入需求（写好后不许改）
  scenarios/{s1,s2,s3}/expected.json   期望的 feature 覆盖清单（机器可比对）
  runner.ts                            跑流水线 → 产出 scorecard.json
  scorecard.ts                         指标计算（纯函数，可单测）
  baseline/before.json                  ★ 用【现有系统】跑出来的基线，删代码前必须先存
```

**评分卡指标**
| 指标 | 计算方式 |
|---|---|
| 前端 build 通过 | `vite build` 退出码 === 0 |
| 后端启动成功 | 进程起 + 健康检查 200 |
| 契约测试通过率 | 通过断言数 / 总断言数（IR 生成，见 §6） |
| 页面非白屏 | renderGate 的元素数/文本长度阈值 |
| 需求覆盖 | `expected.features` 与产物路由/接口清单的集合覆盖率 |
| 端到端耗时 | 从中位 slice 到全 run |
| token 成本 / 项目 | 按模型计价 |
| 人工介入次数 | pause 次数（目标 0，超预算不算） |

**完成判据**
- `bun run eval/runner.ts` 打印完整评分卡；
- `baseline/before.json` 已入库（**先测旧系统，再动手改任何代码**）；
- 评分卡接入提交前检查：分数下降则阻断。

**预估**：2–3 天。**风险**：基线会很难看（参考 p9：阶段 3 六个任务全部 0 产出）。这正是价值所在——它同时是你简历上"用数据推翻自己架构"那一段的证据。

---

## 3. 模块 B：Run Ledger + 状态机 + 调度器（脊柱）

**依赖**：无（可与模块 A 并行）。**零 LLM。**

**交付物**
```
engine/run/state.ts       类型 + 合法迁移（纯函数，100% 单测覆盖）
engine/run/store.ts       持久化（SQLite 优先，MySQL 可选）
engine/run/scheduler.ts   有界池 + 全局并发闸 + 预算
engine/run/events.ts      追加写、类型化事件（前端唯一数据源）
engine/run/budget.ts      时间/token/命令次数计数器 + 熔断
```

**数据模型**
```ts
type SliceState =
  | { s: "planned" }
  | { s: "contracted"; contractRef: string }
  | { s: "implemented"; attempt: number }
  | { s: "verified"; evidence: Evidence[] }        // ← 只有 exec 能构造 Evidence
  | { s: "blocked"; reason: FailureClass; detail: string }
  | { s: "done"; verifiedAt: string; inputHash: string };

type RunState =
  | { s: "running" }
  | { s: "paused"; needs: "user_answer" | "env_fix"; question: Question }
  | { s: "budget_exceeded"; spent: Budget }
  | { s: "done" }                                   // 所有 slice done + 验证新鲜
  | { s: "failed"; reasons: FailureClass[] };

type Step = {
  id: string;            // `${runId}:${sliceId || "-"}:${kind}`  稳定可重算
  kind: StepKind;
  inputHash: string;     // hash(文件集 + 契约 + 命令 + 配置)
  status: "pending" | "running" | "ok" | "failed";
  leaseUntil?: number;   // ★ 崩溃的 worker 超时后自动回收
  result?: unknown;      // 缓存命中直接返回，不重跑
  evidence?: Evidence;   // { cmd, args, cwd, exitCode, stdout, stderr, durationMs, timedOut, artifacts }
};
```

**表**：`run` / `slice` / `step` / `artifact` / `verification` / `event` / `budget_ledger`。

**完成判据**
- 纯函数迁移测试全绿；
- **崩溃恢复测试**：跑一个 3 步假流水线（零 LLM），中途杀进程，重启后从 Ledger 续跑，且**已验证的 step 不重跑**；
- `engine/run/**` 中 grep 不到 `SystemMessage`。

**预估**：3–4 天。**依赖下游**：所有模块。

---

## 4. 模块 C：工作区、骨架与写盘纪律

**依赖**：B。

**为什么高优先级**：这一模块消灭的是**出现频率最高的两类缺陷**——
- `runs/p1`：一个项目里同时存在 `app.py` / `backend/app.py` / `src/routes/auth.py` / `src/api/auth.js`，前端同页有 `Login.vue` / `LoginPage.vue` / `pages/Login.vue` 三个版本 → **四套互斥目录约定**；
- `runs/p9`：有 `index.html`、`vite.config.ts`、`package.json`，**全树没有 `main.ts` 和 `App.vue`** → 前端根本起不来。

**交付物**
```
engine/workspace/sandbox.ts      from runEnv.ts（保留）
engine/workspace/locks.ts        文件级互斥锁（复用 fileTools.withPathLock 思路）
engine/workspace/ownership.ts    文件归属登记 + 跨任务让渡
engine/workspace/skeleton/
  <stack>/manifest.json          允许路径白名单 + 归属 + 是否引擎拥有
  <stack>/templates/**           骨架文件内容（引擎直出）
  <stack>/render.ts              路由登记、request 封装、入口生成（机械渲染）
```

**规则（写盘前强制，非提示词请求）**
1. 引擎拥有件（入口、router 注册、request 封装、构建文件、迁移文件）→ 写入即拒；
2. 路径必须命中 manifest 白名单 → 否则拒绝并附**白名单候选**；
3. 一个文件同时只有一个 writer（锁 + 归属表）；
4. 骨架由引擎生成，任务的 `files` 只能是骨架内的合法路径。

**完成判据**
- 构造一个企图写 `src/foo.py`、覆盖 `main.ts` 的任务 → 被机械拒绝且报错可读；
- 单栈空骨架可启动：前端 `vite build` 过、后端能起（零业务代码）；
- 场景项目跑完后，产物树**只有一套目录约定**（用 p1 的树做对照断言）。

**预估**：3–4 天。

---

## 5. 模块 D：执行与验证层（真正的判决者）

**依赖**：B、C。**这是产品本体，投入最大。**

**交付物**
```
engine/exec/run.ts            命令执行 + 超时 + 进程树杀 + 端口分配 + 日志/产物哈希
engine/exec/classify.ts       机器信号失败分类（见 §8）
engine/exec/fingerprints.ts   错误指纹表
engine/exec/static/           checkers.ts 迁入（★ 只许 reject，补 .java/.xml/.yml/.sql）
engine/verify/types.ts        Verifier 接口 + Evidence 唯一构造点
engine/verify/command.ts      mvn/npm/bun/pytest 封装
engine/verify/http.ts         契约测试驱动
engine/verify/render.ts       from renderGate.ts
engine/verify/migrate.ts      真跑迁移
engine/verify/spring/*        第一条栈：javac/mvn package → 启动 → OpenAPI/HTTP
engine/verify/vue/*           第一条栈：vite build → 渲染
```

**执行顺序不可颠倒**：`编译 → 启动 → 契约测试 → 渲染`。编译不过不启动（省时间、免误判）。`discoverRoutes` **不是**平级能力，它是"启动成功"的下游产物。

**三个必须做对的细节（全是坑）**
1. **进程树杀掉**：Windows 用 `taskkill /T /F`（或进程组）。只杀父进程 → 孤儿占端口 → 下次"端口被占用" → 被误分类为 ENV → 死循环。
2. **端口与工作区隔离**：每 run 分配端口区间 + `_runs/{runId}/`，否则并行 = 随机失败。
3. **静态闸门现状缺口**：`checkers.ts:436-454` 的 DISPATCH 只有 `.vue/.ts|js/.py/.json`，**`.java` 直接返回 `[]` 放行**——你们主栈 Java 的每个文件从来没被检查过。必须补 `.java`（有 JDK 就真 javac）+ `.xml`（pom.xml！）+ `.yml` + `.sql`。

**完成判据**
- 冻结场景的 phase-1 slice 能产出**完整证据链**（编译退出码 + 启动日志 + HTTP 断言 + 渲染结果）；
- 故意注入一个"编译能过但接口 404"的 slice → 被**执行**抓住（而非被 LLM 抓住）；
- 故意注入一个 Java 语法错误 → 被静态闸门抓住（现在抓不住）。

**预估**：5–7 天。**这是唯一值得你多花时间的模块**——它是"两个 runtime 共用"的层（见 §9.3）。

---

## 6. 模块 E：IR 与契约（把散文变可执行）

**依赖**：B。

**为什么**：现状 `CONTRACTS.md` 是 LLM 生成的散文且**可被静默旁路**（`contracts.ts:157-160` catch 后 return null，全员按"无契约"跑）。p9 那份"全局唯一真相"里主栈字段重复三次，且与同一文档中 PM 亲答的"9 页面 + TDesign"自相矛盾。同时 `expectedApisOf`（`foundation.ts:372`）用正则解析 `task.description` 的文本行取期望接口——**换个写法就漏检，漏检即放行**。

**交付物**
```
engine/ir/spec.ts         Spec { goal, features[], constraints[], acceptance[], openQuestions[] }
engine/ir/plan.ts         Plan { stack, slices[], deps }
engine/ir/slice.ts        Slice { id, kind, contractRefs[], files[], acceptance[] }
engine/ir/contract.ts     Contract { endpoints[] }（★ request/response 结构化字段）
engine/ir/acceptance.ts   ★ 可执行验收（三选一，无第四种）
engine/ir/render/
  openapi.ts  client-stub.ts  server-stub.ts  test-case.ts  docs.ts
```

**验收 IR（关键设计，堵住"散文换容器"）**
```ts
type Acceptance =
  | { kind: "http";     request: {...}; expect: { status: number; jsonPath: Record<string, Predicate> } }
  | { kind: "command";  run: string; expect: { exitCode: 0 } }
  | { kind: "testFile"; path: string };            // 引擎负责跑它
// 自然语言只允许存在于 displayAcceptance?: string[]，禁止进入 Verifier
```

**一份 IR，多个渲染器**：契约 → 前端请求桩 + 后端接口桩 + 契约测试用例 + 文档。两侧共享同一份定义，而不是各自实现后靠比对。

**完成判据**
- 改契约 → 机械重新生成桩与测试用例（零手工同步）；
- 非法的 acceptance（纯自然语言、或 http 缺 expect）在**规划期**被拒，而不是验证期；
- `expectedApisOf` / `pairIntegrationCheck` 的判决权被移除（保留为失败报告里的诊断附注）。

**预估**：4–5 天。

---

## 7. 模块 F：LLM 步骤与 Agent 拓扑

**依赖**：B、D、E。

### 7.1 收敛到 7 个 LLM 边界

| # | step | 输入 | 输出（过 schema） | 禁止 |
|---|---|---|---|---|
| 1 | `analyze` | 用户输入 | Spec（含 `openQuestions`） | 乱填 acceptance；有 openQuestions 不停 |
| 2 | `plan` | Spec + **仓库扫描结果** | Plan | 凭记忆选型（必须读 `package.json`/`pom.xml`） |
| 3 | `contract` | Slice + Spec | Contract IR | 输出散文契约 |
| 4 | `skeleton` | Stack + Plan | 骨架文件**内容**（路径由引擎给） | 决定任何路径 |
| 5 | `implement` | 契约 + 允许/禁止文件 + 骨架 | 文件内容（工具循环，有界） | 宣布成功 |
| 6 | `repair` | **机器证据（stderr 原文）** + 当前文件 | 补丁 | 无证据时猜测式重写 |
| 7 | `report` | run 记录 | 人类可读报告 | 参与任何判定 |

现状是 15+ 个散落调用点（`manager` 3 节点 + `architect` 6 节点 + 4 工位 + `testEngineer` + `contracts` + `foundation`），收敛到 7 个。

### 7.2 Agent 拓扑（多 Agent 保留，消息总线删除）

```
Orchestrator（确定性状态机，零 LLM —— 不是 agent，是裁判席）
├─ Worker Pool（并行、上下文隔离）
│   ├─ Implementer(slice, file)
│   ├─ Repairer(slice, evidence)
│   └─ Migrator(slice)
├─ Verifiers（★ 不是 LLM，是命令 —— 见 §5）
├─ Advisor Pool（LLM，独立上下文，★ 无批准权）
│   ├─ PlanSmith ×3       并行出 3 份计划 → 机器打分择优
│   ├─ ContractSmith
│   ├─ Adversarial Reviewer  只能提 blockingQuestions，永不 pass
│   └─ FailureExplainer      只进报告
└─ Event Stream（类型化追加写）→ 前端"团队视图"
```

**多 Agent 只在四个理由下成立**：① 上下文隔离 ② 并行 ③ 验证不对称 ④ 生成—选择。四条都不占就别加 agent。

### 7.3 权限铁律

> **Agents 只能提议，命令才能批准。Advisor 只能 hold，不能 pass。**

- `Adversarial Reviewer` 输出 `blockingQuestions: Question[]`，**没有 `pass` 字段**；
- 每条问题必须带 `reproduce`（一条命令或 `文件:行`），拿不出可复现路径 → 降级 advisory，不阻断；
- `PlanSmith ×3` 择优必须**机器打分**（需求覆盖矩阵 / 契约依赖无环 / 栈可行性 / 粒度合规），不许第四个模型当评委。

### 7.4 模型档位（现状是反的，必须改）

`models.ts:111-114` 现在是 `architect/test/frontend = pro`、`backend/pseudo = flash` —— **真正写代码的工位用最便宜的模型**。改为：
- **强模型**：`implement`、`repair`（要在工具循环里自我纠正）；
- **便宜模型**：`report`、`explain`、`docs`；
- `plan`/`contract` 视成本与实测择优（用评分卡决定，别凭感觉）。

### 7.5 完成判据
- `grep SystemMessage` 命中数 = 7 个边界文件（由架构测试强制）；
- Advisor 无法把 `verified` 翻成 `done`（构造测试证明）；
- 3 份候选计划的机器评分差异可见（证明择优有效，而非摆设）。

**预估**：5–6 天。

---

## 8. 模块 G：失败分类、预算与恢复

**依赖**：B、D。可与 F 并行。

**交付物**：`engine/exec/classify.ts`、`engine/run/budget.ts`、恢复路径。

**分类必须来自机器信号**
| 失败类 | 机器信号（唯一依据） | 路由 |
|---|---|---|
| COMPILE | `javac/mvn/vite build` 退出码≠0 且产物为编译诊断 | 回 Implementer/Repairer |
| CONTRACT | 契约测试退出码≠0 且失败为断言/404/422 | 回 Planner 重生成该 slice 契约 |
| TEST | `Tests run:.*Failures: [1-9]` / `FAILED` | 回 Implementer |
| ENV | 指纹：`Could not resolve dependencies` / `EADDRINUSE` / `ECONNREFUSED` / `ETIMEDOUT` | 环境恢复 → 失败则 pause |
| SPEC | 机器无信号，**必须**由 `openQuestions[]` 非空触发 | pause 请求用户 |
| BUDGET | 计数器超限 | pause + 报告，**不续烧** |

LLM 只能做 tiebreaker，且结论必须引用证据原文，否则丢弃。

**预算**：per-slice（wall time / tokens / 命令次数）+ per-run 上限。超限 → `paused`/`budget_exceeded` + 报告，绝不静默继续。

**恢复**：租约到期 → 回收；从 Ledger 续跑；已验证 step 不重跑。

**项目 done 定义**：全部 slice `done` 且验证新鲜。**0 任务 / 0 产物的阶段 = `failed`，不是完成**（现状 `architect.ts:849-853` 会主动"声明 0 对完成"）。

**完成判据**：注入 5 类合成失败 → 路由正确；验证中途杀进程 → 能续跑。

**预估**：3 天。

---

## 9. 模块 H：前端与交付

**依赖**：B（事件流）、G（失败报告）。

**核心变化**：从"团队聊天秀"改成**运行报告**。

**交付物**
- 运行报告页：每 slice 状态 / 失败类 / 命令 / 退出码 / 证据文件链接 / 恢复按钮；
- 团队视图：由 `run_events` 渲染（角色、进度、**证据**），不再是"正在思考…"；
- 交付层：打包 zip / 预览 / 桌面端（SQLite + 本地 key）路径。

**完成判据**：一个不懂内部实现的人，只看报告页能回答"哪里失败、为什么失败、下一步做什么"，**不需要读日志**。

**预估**：3–5 天。

---

## 10. 模块 I：切流、删除与上线

**依赖**：全部。

**切流（strangler，不搞大爆炸）**
1. 新流水线在 feature flag 后并行运行，用冻结场景对比新旧评分卡；
2. 新 ≥ 旧 + 阈值 → 切默认；
3. 按序删除：`maintainer` → `merger` → `Hub`/`BaseAgent` → `GraphFactory`/注册表 → DB 图退出运行时路径（表留作模板库）。

**删除顺序原则**：先删"叶子"（记账、配对），后删"主干"（Hub）。每删一段跑一次评测，分数不许掉。

**上线门（全部满足才发）**
- 冻结场景评分卡达阈值（前端 build 100%、后端启动 100%、契约测试 ≥ 目标值、页面非白屏）；
- 所有失败路径都是**显式失败**（0 产物 = failed）；
- 崩溃/超预算可恢复，有报告；
- 无静默降级：契约生成失败、骨架缺失、图校验失败一律**报错**，不旁路。

**预估**：3–4 天 + 观察期。

---

## 11. 时间表、砍单清单、风险、依赖图

### 11.1 依赖图与关键路径

```
A 评测基准 ──┐
             ├─→ D 验证层 ──→ F LLM步骤/拓扑 ──┐
B 脊柱 ──────┤                                  ├─→ I 切流上线
             ├─→ C 工作区骨架 ─┘                │
             ├─→ E IR/契约 ────────────────────┤
             └─→ G 分类/预算/恢复 ─────────────┘
H 前端交付（依赖 B + G）
```

**关键路径**：A/B → D → F → I。

### 11.2 时间表（1–2 人）

| 周 | 交付 |
|---|---|
| W1 | A（评测 + 旧系统基线）+ B（Ledger/状态机/调度器，含崩溃恢复测试） |
| W2 | C（骨架/写盘纪律）+ D 上半（exec + 静态闸门补 `.java`） |
| W3 | D 下半（spring/vue 验证器 + HTTP 契约测试）+ E（IR/契约） |
| W4 | F（7 边界 + Agent 拓扑）+ G（分类/预算/恢复） |
| W5 | H（报告页）+ I（切流、删除、上线门） |
| W6 | 观察期 + 固化评测回归 |

### 11.3 只有两周时的砍单顺序（从后往前砍）

1. 砍 `PlanSmith ×3`（先 ×1）→ 2. 砍 `Adversarial Reviewer`（验证层已够）→ 3. 砍桌面端打包 → 4. 砍第二条栈 → 5. 砍交付 zip（先给产物树 + 报告）→ 6. 砍前端美化（报告页用最朴素的表格）。
**绝不砍**：A（评测）、D（验证）、C（骨架/写盘纪律）、G 的"0 产物 = 失败"。

### 11.4 风险表

| 风险 | 影响 | 缓解 |
|---|---|---|
| 验证层比预期重（依赖下载/启动耗时） | 上线延期 | 端口/工作区隔离 + 结果按 inputHash 缓存 + 编译不过不启动 |
| 弱模型在工具循环里耗尽轮次 | 整阶段 0 产出（p9 已发生） | 轮次耗尽**退单发老路**；未命中提示不许写"换个关键词"；预留写盘轮次 |
| 端点超卖 | 超时/截断/443s 尾延迟 | 按端点容量定并发；宁串行跑完一个项目 |
| 骨架模板覆盖不足 | 非模板栈跑不通 | 首版只支持 1–2 条栈，明确不支持清单 |
| 重写期间旧系统不可用 | 无法交付 | strangler 切流，旧路径保活到新路径达标 |

### 11.5 立即动手的三件事（今天）

1. **存基线**：用**现有系统**跑 3 个场景，把评分卡存成 `eval/baseline/before.json`（删代码前唯一机会）。
2. **堵一个洞**：`checkers.ts` DISPATCH 补 `.java`（有 JDK 走 javac）+ `.xml/.yml/.sql`；顺手把 `fileTools.ts` 的轮次耗尽改成退单发老路、把"换个关键词"话术删掉。
3. **立不变量**：加两个架构测试（`SystemMessage` 只许出现在 `steps/`+`agents/`；`Evidence` 唯一构造点在 `exec/`）。

---

## 12. 模块 J：自定义层（哪些支持，哪些不支持）

跨切面模块，与 B/C/E/F 并行落地。**上线版只开放 T1 + T2 的一部分。**

### 12.1 唯一的准入判据

> **一个维度可以开放给用户自定义，当且仅当「用户把它改坏」能被机器检测出来，并且检测结果能给出可读的修复指引。**
> 任何"改坏了只能靠 LLM 兜底"的位置，一律不开放。

由此得到本模块最重要的一条推论：

> **可自定义的边界 = 验证器的覆盖边界。没有 Verifier 适配器的栈，不允许出现在可选列表里。**

理由来自现状：`Node.nodePrompt`（`Node.ts:147`）允许用户 prompt **整体替换**内置 prompt，却没有配套 schema 与闸门；`architect.ts:414` 的注释自己写着"stack/bootstrap 提示词会被 DB 旧行覆盖（`sys_agent_node` 早先入库），代码侧才钉得住"，于是逼出了 `enforceElementPlusFoundation` / `ensureRequestFoundation` 这类"代码兜底不靠提示词自觉"的补丁。**那些补丁就是"替换式自定义"的账单。**

### 12.2 分层总表

**（a）支持 vs 不支持一览（速查）**

| 维度 | 上线版 | 理由 |
|---|---|---|
| 技术栈（枚举内选） | ✅ T1 | 枚举 + "必须有 Verifier 适配器"双重约束 |
| 模型 / 端点 / 分档 / key | ✅ T1 | 已有能力；补"能力探测"，探测失败**明确告知** |
| 并发与预算数值 | ✅ T1 | 数值 clamp 到安全区间 |
| 命名 / 注释 / 语言风格 | ✅ T1 | 有限枚举 |
| 额外禁用依赖包 | ✅ T1 | **已有机械闸门**（`banned-imports`）兜着，改坏必被抓 |
| 工位**附加指令**（append） | ✅ T2 | 只能"加要求"，不能"删约束" |
| 项目上下文文档（术语 / 业务规则） | ✅ T2 | 只作为 analyze/plan 的**输入**，不进判据 |
| 项目模板（选，不能改结构） | ⏸ T3 | 等模板自测就位 |
| 自定义新栈 | ⏸ T3 | 先交 Verifier 适配器 + 自测，才进枚举 |
| 控制流 / 图 / 节点 / 边 / 阶段顺序 | ❌ T0 | 半套配置会**静默拼出不干活的图**，结果是"跑完了但什么都没有" |
| 重试 / 预算 / 收敛策略 | ❌ T0 | 决定成本与收敛，用户无法评估 |
| 骨架结构 / 目录 / 入口 / 路由登记 / 构建文件 | ❌ T0 | `runs/p1` 四套目录、`runs/p9` 缺 `main.ts` 的直接来源 |
| 文件 ownership（谁写哪个文件） | ❌ T0 | 并发写同一文件 = 静默数据损坏 |
| **系统提示词骨架**（角色 / 输出协议 / 权限） | ❌ T0 | 只能追加，不能替换（见 12.5） |
| 验收语义 / 判据 / 失败分类规则 | ❌ T0 | 判据一旦可自定义，"通过"就失去客观性 |
| code 节点 / 条件边函数体 / 注入 JSON Schema | ❌ T4 | 永不开放 |
| 团队与角色编排 | ❌ T4 | **永不开放**（这正是原方案想做的那个功能） |

**（b）四层分级**

| 层 | 形态 | 载体 | 校验方式 | 上线版 |
|---|---|---|---|---|
| **T0** | 引擎拥有，**不开放** | 代码 | — | ❌ |
| **T1** | 参数化（枚举 / 数值 clamp） | `sys_settings` + 项目配置 JSON | 枚举白名单 + 数值上下限 | ✅ 开放 |
| **T2** | 追加式（append-only，不可替换） | 项目配置 JSON | 长度上限 + 角色白名单 + 机械闸门 | ✅ 开放（限两项） |
| **T3** | 模板化（结构扩展） | 引擎提供的**已自测**模板 | 模板自身自测 + 选择时校验 | ⏸ 验证器覆盖后 |
| **T4** | **永不开放** | — | — | ❌ 永久 |

### 12.3 T0：不开放清单（及理由）

| 不开放项 | 理由（都有现状证据） |
|---|---|
| 控制流（图 / 节点 / 边 / 阶段顺序 / 重试与预算策略） | DB 图是控制平面：半套配置（有边无节点或节点齐全但缺 `dispatch`）会**静默拼出一个不干活的图**，结果"项目跑完了但什么都没有"（`projectRunner.ts:85` 的回落条件只判"有节点且有边"） |
| 判据（验收语义、验证命令的选择逻辑、失败分类规则） | 判据一旦可自定义，"通过"就失去了客观性；且用户无法理解失败类语义，只会把所有失败当成 bug 报给你 |
| 骨架结构（目录约定、入口、路由登记、构建文件、迁移文件位置） | `runs/p1` 四套互斥目录、`runs/p9` 缺 `main.ts`/`App.vue` —— 路径一旦交给用户/LLM 决定，前端根本起不来 |
| 谁是哪个文件的 writer（ownership） | 并发写同一文件是静默数据损坏，必须由引擎裁决 |
| **系统提示词的骨架**（角色边界、输出协议、权限声明） | 见 12.5：只允许"追加"，不允许"替换" |
| 契约中机器可校验的部分（endpoint 的 request/response 结构、acceptance 的可执行形式） | 用户可以描述"要什么"，不能重新定义"怎样才算通过" |

### 12.4 T1：参数化（上线版开放）

| 可自定义项 | 形态 | 校验 | 非法时 |
|---|---|---|---|
| 技术栈 | 枚举（首版 1–2 条栈） | **必须存在 Verifier 适配器且适配器自测通过** | 拒绝 + 列出可用栈 |
| 模型与端点 | `modelKind` / `modelUrl` / `apiKey` / 分档模型名 | 连接探测 + **能力探测**（工具调用、结构化输出、上下文长度） | 探测失败 → 明确告知降级为"无工具路径"，**不静默** |
| 并发与预算 | 数值 | clamp 到安全区间（如并发 1–N、单 run 时长上限） | 超界 clamp + 界面提示实际生效值 |
| 命名 / 注释 / 语言风格 | 有限枚举 | 枚举白名单 | 拒绝 + 候选 |
| 依赖策略（额外禁用包） | 字符串清单 | **已有机械闸门**（`banned-imports`），只允许"加"不允许"减" | 拒绝 |

> **范式说明**：`models.ts:117-129` 的 `resolveRoleTier` 已经是"坏 JSON → 回落内置表，旁路不炸"的正确形状，**保留这个思路并推广到所有 T1 项**；但要补一条：**旁路必须告警**（现在是 `catch {}` 静默回落）。静默回落是你们的病根之一。

### 12.5 T2：追加式（上线版开放两项）

| 可自定义项 | 落点 | 约束 |
|---|---|---|
| **工位附加指令** | append 到 `steps/*` 内置 prompt **尾部** | ≤ N 字符；**不可替换**；不可触及输出协议/权限声明/schema/`files`；越界词表命中即拒绝 |
| **项目上下文文档** | 作为 `analyze`/`plan` 的**输入**（领域术语、业务规则） | 不进任何判据；≤ M 字符 |
| （暂缓）禁用清单扩展 | 合并进 `bannedDependencies` | 只加不减 |

**关键区别**：替换式自定义让用户能"删掉安全约束"；追加式自定义只能"加要求"。前者必须彻底禁止，后者爆炸半径可控。

### 12.6 T3：模板化（**等验证器覆盖之后再开**）

- **项目模板**：引擎提供、引擎验证过的一等模板；用户**只能选，不能改结构**。
- **自定义栈**：准入流程固定为 —— ① 实现该栈的 `Verifier` 适配器 → ② 适配器自测通过（含"故意坏项目必须被抓"用例）→ ③ 该栈才出现在枚举里。**没有第 ② 步，就没有第 ③ 步。**
- **团队 / 角色编排**：**永不开放**（T4）。这正是原方案想做的"用户自定义节点与编排"，也是本计划砍掉的东西。

### 12.7 T4：永不开放（写进产品文档，明确告诉用户"不支持"）

1. 自定义 code 节点 / 条件边函数体 / 注入 JSON Schema；
2. 替换系统提示词；
3. 自定义验收语义（用户只能声明"这些接口/命令必须通过"，不能声明"我认为它通过了"）；
4. 自定义控制流、阶段顺序、重试与预算策略；
5. 自定义判据与失败分类。

### 12.8 强制机制（靠类型与测试，不靠纪律）

```ts
// 用户输入的类型边界：只允许流向这些字段
type UserSupplied = {
  stackId?: StackId;                       // 枚举
  appendInstructions?: Record<StepKind, string>;   // 只追加
  projectContext?: string;                 // 只进输入
  allowedExtraBans?: string[];             // 只加不减
  budgets?: BudgetOverrides;               // clamp
};
// 禁止出现：Acceptance / Contract / files / FailureClass / PromptSkeleton 的任何字段
```

四条落地点：

1. **`validate()` 必须有，且非法时拒绝 + 给候选 + 可读错误**——绝不静默回落（对应不变量 6 的精神）。
2. **架构测试**：`UserSupplied` 类型不得出现在 `engine/ir/acceptance.ts`、`engine/verify/**`、`engine/run/classify.ts` 的入参里（编译期 + 测试双重保证）。
3. **版本化**：每个自定义项带 `schemaVersion`；升级时迁移；运行时先校验再使用，校验失败 = 拒绝启动并报错。
4. **可观测**：任何一次"用户自定义生效"写进 `run_events`，报告页可见 —— 出问题时你能一眼分清**是引擎的锅还是用户配的锅**（这正是现状最缺的一条：DB 旧 prompt 覆盖了内置 prompt，日志里看不见）。

**默认值必须等于内置行为**（沿用你们已有的"不配 = 逐字节不变"原则，推广到全部 T1/T2 项）。

### 12.9 存量数据迁移

| 现状 | 处置 |
|---|---|
| `sys_agent_node` / `sys_project_agent_node` / `sys_agent_edge` | 运行时**不再读取**；导出 JSON 归档后置 `deleted=1`。若要保留成"模板库"，必须过图校验器（必需节点齐全 / 通道唯一 / schema+code key 存在）才可被引用 |
| 用户已配置的**替换式 prompt** | **不改行为地导入为 `appendInstructions`**（把原 prompt 作为追加内容），并在报告页提示"已从替换模式转为追加模式"。宁可语义略变，也不要静默丢掉用户输入 |
| `sys_settings` | 保留，作为 T1 参数的正式落点（它本来就是"运行时配置"的正确位置） |

### 12.10 UI 规则

- 配置页**只显示 T1/T2/T3 可选项**；T0 完全不出现在界面上。
- **一条铁律：不能自定义的地方不要给输入框——给了输入框就是给了承诺。**
- T3 显示为"只读的可选模板"，并显示"该模板已通过自测"标记。
- 每个可自定义项旁显示**实际生效值**（尤其被 clamp 的数值）。

### 12.11 放开下一层的门槛（用指标说话，不靠感觉）

全部满足才允许从 T2 提升到 T3 / 开放新栈：

1. 冻结场景评分卡达标（模块 A）且连续两个迭代不下滑；
2. 新栈的 `Verifier` 适配器存在，且自测包含"故意坏项目必须被抓"用例；
3. 静默降级告警数 = 0（含契约旁路、骨架缺失、配置回落）；
4. 自定义项的**拒绝率与错误类型**已可观测（能回答"用户最常配错什么"）。

### 12.12 完成判据

- 用户改坏任一 T1 项 → 得到可读错误 + 候选，**而不是静默回落**；
- 构造测试：用户自定义**无法**影响 `acceptance`、`files`、判据与失败分类（架构测试红）；
- 报告页能区分"用户配置生效"与"引擎默认生效"；
- 产品文档里有一节明确列出 T4"不支持清单"。

---

## 附：一页速查

- **判据**：命令 + 退出码，其余都是建议。
- **控制流**：代码里的状态机；数据库不是控制平面。
- **多 Agent**：保留并行与上下文隔离；删掉消息总线；Advisor 只有 hold 权。
- **骨架**：引擎拥有；LLM 不许决定路径。
- **失败**：分类来自机器信号；0 产物 = 失败；超预算 = 停。
- **自定义**：边界 = 验证器的覆盖边界；只开放 T1 参数化 + T2 追加式；替换式 prompt、控制流、判据永久不开放。
- **顺序**：先尺子（A）→ 再脊柱（B）→ 再判决者（D）→ 最后才谈体验（H）。
