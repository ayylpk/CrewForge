# CrewForge 重写执行计划（执行版 / Owner Plan）

> 关系说明：本文是 `2026-09-10-pipeline-rewrite-plan.md`（设计版）的**执行版**。
> 设计版保留作为架构论证与不变量来源；本文回答"谁在什么时候改哪些文件、怎么验收、什么时候能上线"。
> 授权：架构可改、技术栈可增、项目由我负责。生效日期：2026-09-10。

---

## 0. 已确认的施工环境（实测，非假设）

| 能力 | 状态 | 施工影响 |
|---|---|---|
| bun 1.3.14 / node 24.8.0 / npm 11.6.0 | ✅ | 引擎与前端构建可用 |
| java 17.0.18 + **javac 17.0.18** | ✅ | **Java 真编译闸门可落地**（当前 `.java` 零校验） |
| maven（全局） | ❌ | 用 `backed-CrewForge/mvnw`；`~/.m2/repository` 已存在 |
| python 3.12.7 | ✅ | py_compile / 测试驱动可用 |
| **docker 29.6.2** | ✅ | **执行式验证的物理基础**：每 run 独立容器 + 独立 MySQL |
| mysql 客户端 | ✅ | 库可连（执行时复验） |
| 前端依赖（vite / vue-tsc / element-plus / monaco） | ✅ | 可构建、可回归 |
| `DEEPSEEK_API_KEY` / `DB_PASSWORD` | ✅ | 端到端可跑（密钥值不入库、不入日志） |

**由环境事实推出的三条决定性结论**

1. **执行式验证是可行的**，不再需要退而求其次做"纸审"——Docker 解决了"生成的后端需要 MySQL 才能启动"这一此前无法逾越的障碍。
2. **Java 在生成项目里的占比最高**（p9 的 45 个文件里绝大多数是 `.java`），而它当前**一个字节都没被检查过**（`checkers.ts:436-454` 的 DISPATCH 无 `.java`）。这是投入产出比最高的一处。
3. **不需要换语言重写**。TS/Bun 引擎的资产（`runEnv.ts` 沙箱、`renderGate.ts` 渲染判定、`settings.ts` 配置层、`checkers.ts` 骨架）可复用，重写语言只增加风险不增加收益。

---

## 1. 由我拍板的技术决策（不再征询）

| # | 决策 | 理由 |
|---|---|---|
| D-1 | 引擎保留 TypeScript + Bun；**重写控制平面，不重写语言** | 复用既有资产；控制流位置才是病根 |
| D-2 | 控制流 = **显式状态机 + 持久化 Ledger**（`run/slice/step/artifact/verification/event/budget`），零 LLM | 设计版 §1.2 不变量 1/6/7 的落地形态 |
| D-3 | **引入 Docker 作为验证底座**：每 run 一套 `app + mysql` 容器，端口与数据卷隔离，退出必清理 | 使"启动 + HTTP 契约 + 迁移"可执行；避免污染宿主 |
| D-4 | **Ledger 双后端**：SQLite（桌面/本地，零配置）与 MySQL（服务端）由 `db.ts` 抽象切换 | 兼容既有服务端，同时为桌面端铺路 |
| D-5 | **删除 DB 节点/边控制平面**（`sys_agent_node`/`sys_agent_edge`/`sys_project_agent_node` + `GraphFactory` + 三注册表 + Java 20 文件 + 前端编排页）；表经导出后归档 | 控制流进数据库是静默故障的源头（半套配置 → 不干活的图） |
| D-6 | **提示词进 git**（`engine/agents/prompts/**`），禁止 DB 覆盖 | 消除"DB 旧 prompt 顶掉内置 prompt → 写代码兜底"这一类补丁 |
| D-7 | 首条栈固定为 **Vue3 + Element Plus + Vite / Spring Boot 3 + Java 17 + MyBatis-Plus / MySQL 8**，与 `enforceElementPlusFoundation` 和你们自有前端一致 | 消除"prompt 要 TDesign、代码装 Element Plus"的自相矛盾（D9） |
| D-8 | 校验优先级：**编译 → 启动 → 契约 → 渲染**，编译不过不启动 | 省时且免误判 |
| D-9 | 模型档位：`implement`/`repair` 用 **pro**（写代码与自我纠正），`pseudo`/`contract`/`report` 用 flash | 修正"写代码的工位用最便宜模型"的倒置 |
| D-10 | 多 Agent 保留：**并行 Worker（上下文隔离）+ Advisor（只有 hold 权，无 pass 权）**；消息总线删除 | 设计版 §7 |
| D-11 | 前端：**配色与 CSS 一律不改**（硬约束）；信息架构可从"团队聊天"改为"运行报告"，但只复用既有组件与样式变量 | 用户约束 3 |
| D-12 | 执行器可替换：`AgentRuntime` 接口 + `builtin` 实现（任意 OpenAI 兼容端点）；`harness` 适配位预留不实现 | 保留模型可替换这一产品身份 |

---

## 2. 不变量（我按此验收每一行代码）

1. 任何"通过"必须可追溯到**一条命令 + 退出码**。
2. 机器静态检查**只许 reject，不许 approve**。
3. 进入 Verifier 的字段必须可执行；自然语言只能进 `display*`。
4. 骨架与入口归引擎，越界路径写盘前拒绝。
5. 一个文件同一时刻只有一个 writer。
6. **0 产物 / 0 任务 = 显式失败，永不 `done`**。
7. step 幂等可重放，结果按 `inputHash` 缓存。
8. 失败分类只来自机器信号；LLM 仅 tiebreaker。
9. 每 slice / 每 run 有硬预算，超限暂停报告。
10. `SystemMessage` / `initModels` 只允许出现在 `engine/steps/**` 与 `engine/agents/**`。
11. `Evidence` 只能由 `engine/exec/**` 构造（类型层面堵死"LLM 宣布成功"）。

**10 与 11 用架构测试强制**（编译期 + 测试双保险），不靠自觉。

---

## 3. 目标仓库结构

```
agents-CrewForge/
  engine/
    run/        state.ts store.ts scheduler.ts events.ts budget.ts
    ir/         spec.ts plan.ts slice.ts contract.ts acceptance.ts
                render/{openapi,client-stub,server-stub,test-case,docs}.ts
    workspace/  sandbox.ts locks.ts ownership.ts
                skeleton/<stack>/{manifest.json,templates/**,render.ts}
    exec/       run.ts classify.ts fingerprints.ts static/{js,vue,py,java,xml,yml,sql}.ts
    verify/     types.ts docker.ts command.ts http.ts render.ts migrate.ts
                spring/*  vue/*
    steps/      analyze.ts plan.ts contract.ts skeleton.ts implement.ts repair.ts report.ts
    agents/     pool.ts advisor.ts prompts/**
    config.ts   cli.ts
  legacy/       过渡期存放待删旧文件（不被 import）
  smoke/        既有 smoke 迁入 + 新增
```

**过渡原则**：新旧并存，`legacy/` 内的文件在对应模块切流完成后删除；任何时刻仓库保持可编译、可运行。

---

## 4. 里程碑（每个里程碑结束时系统都处于可用状态，无长期破坏窗口）

### M0｜侦察与基线（0.5 天）— 已完成大半
- 工具链探测 ✅（见 §0）
- 复验：DB 连通、`bun x tsc --noEmit` 当前状态、全 smoke 红绿清单
- **用改动前的代码跑一次端到端并保存 `eval/baseline/before.json`**（旧代码的评分卡，唯一机会）
- 交付：`docs/baseline/before.md`（现状红绿清单 + 端到端得分）

### M1｜评测基准（1.5–2 天）★ 尺子
- `eval/scenarios/{s1,s2,s3}`：3 个冻结输入（含一个 p9 式的"多页面 + 多接口"场景）
- `eval/scorecard.ts`（纯函数，可单测）+ `eval/runner.ts`
- 指标：前端 build 通过 / 后端启动 / 契约测试通过数 / 页面非白屏 / 需求覆盖 / 耗时 / token / 人工介入
- 门：`bun run eval/runner.ts` 出分；基线入库；后续每个里程碑重跑
- **验收**：能回答"这次改动让质量从 X 到 Y"

### M2｜Ledger + 状态机 + 调度器（3–4 天）— 零 LLM
- `engine/run/**`：`SliceState` / `RunState` / `Step`（`inputHash` + `leaseUntil`）
- `db.ts` 双后端抽象（SQLite / MySQL）
- 门：**崩溃恢复测试**（3 步假流水线中途杀进程 → 续跑 → 已验证 step 不重跑）；架构测试（`SystemMessage` 不得出现在 `run/`）
- **验收**：`state.ts` 纯函数 100% 覆盖

### M3｜执行与验证层（5–7 天）★ 判决者
- `engine/exec/**`：命令执行（超时 / **进程树杀** / 端口分配 / 日志与产物哈希）
- `engine/exec/static/**`：`checkers.ts` 迁入 + **补 `.java`（javac 真编译，退化路径为结构校验）/`.xml`（pom.xml！）/`.yml`/`.sql`**
- `engine/verify/**`：Docker 编排（app + mysql 容器、健康检查、**退出必清理**）、Spring（`mvnw package` → 启动 → OpenAPI/HTTP）、Vue（`vite build` → 渲染）、迁移真跑
- 门：冻结场景 phase-1 slice 产出完整证据链；注入"编译能过但接口 404"→ **被执行抓住**；注入 Java 语法错 → 被静态闸门抓住
- **验收**：证据链可点开、可复现

### M4｜工作区 / 骨架 / 写盘纪律（3 天）
- `workspace/skeleton/spring-vue/**`：manifest（白名单 + 归属 + 引擎拥有件）+ 模板 + 渲染器
- 文件锁 + ownership + 禁改清单（写盘前强制）
- `ensureEngineEntries()`：机械直出/修复 `main.ts` / `App.vue` / `index.html` 入口指向（消 D8）
- 门：越界路径被拒且报错可读；空骨架可启动（前端 build 过、后端能起）；产物树**只有一套目录约定**
- **验收**：p1 的"四套目录"与 p9 的"缺入口"两类缺陷结构上不可能再生

### M5｜IR 与契约（3–4 天）
- `ir/acceptance.ts`：三选一可执行形态（`http` / `command` / `testFile`），自然语言仅入 `display*`
- `ir/contract.ts`：结构化 request/response → 渲染前端桩 + 后端桩 + **契约测试用例** + 文档
- 废除 `expectedApisOf` 的文本正则（改读 `ExecTask.method/path` 与结构化清单）
- 门：改契约机械重生成桩与用例；非法 acceptance 在**规划期**被拒
- **验收**：`CONTRACTS.md` 散文退出判据链路

### M6｜LLM 步骤与 Agent 拓扑（4–5 天）

**角色口径（唯一权威口径，5 个角色 / 7 个模型调用点）**

角色 = **职责与权限边界**（文档、代码目录、UI 展示统一用这 5 个名字）；
调用点 = 模型**实际被调用**的位置（实现细节，不等于角色数）。
**Verifier 与 Integrator/Recovery 零 LLM**——这正是"判决权不在模型手里"的结构保证。

| 角色 | 模型调用点 | 权限（只能做什么） |
|---|---|---|
| **Product Analyst** | `analyze` | 产出结构化 Spec + `openQuestions`；有开放问题必须停 |
| **Planner** | `plan` / `contract` / `skeleton` | 产出计划与契约 IR；**不得决定任何文件路径** |
| **Implementer** | `implement` / `repair` | 只能改白名单内文件；**不能宣布成功** |
| **Verifier** | **0 个**（命令） | **唯一有"批准"权的角色**（退出码） |
| **Integrator / Recovery** | `report`（非权威） | 调度、收敛、记账、报告；不参与判定 |

补充口径（避免再次出现"到底是几个 agent"的歧义）：
- **Migrator 不单列**为一个角色：迁移归拥有该表的 Implementer（早期已判定"独立迁移执行器 v1 砍掉"）。
- **Advisor 不是第 6 个角色**，而是挂在角色域上的顾问：`PlanSmith ×3` 属 Planner 域、`Adversarial Reviewer` 属 Verifier 域、`FailureExplainer` 属 Integrator 域；它们**只有 hold 权，没有 pass 字段**。
- **"5 个角色" ≠ "5 个进程/5 个并发实例"**：运行时是 1 个确定性 Orchestrator + **同一角色的 N 个并行实例**（Worker Pool，上下文隔离）+ 命令式子进程 + 按需 Advisor。与现有"backend1/backend2"多实例是同一思路，只是不再互发消息。

- 7 个调用点：`analyze / plan / contract / skeleton / implement / repair / report`
- `agents/pool.ts`（并行、上下文隔离）+ `agents/advisor.ts`（`blockingQuestions` + `reproduce`，**无 pass 字段**）
- `PlanSmith ×3` + **机器打分择优**（覆盖矩阵 / 依赖无环 / 栈可行性 / 粒度）
- 档位按 D-9；prompt 进 git（`agents/prompts/**`）
- 门：架构测试（`SystemMessage` 仅在 `steps/`+`agents/`）；构造测试证明 Advisor 无法把 `verified` 翻成 `done`
- **验收**：`grep SystemMessage` 命中 = 7 个边界文件

### M7｜失败分类 / 预算 / 恢复 + 删除旧控制平面（4 天）
- `classify.ts`：指纹表 + 退出码 + 工具身份（COMPILE/CONTRACT/TEST/ENV/SPEC/BUDGET 六类分流）
- 预算熔断：per-slice + per-run（wall time / tokens / 命令次数）→ 超限暂停报告
- **删除**：`Hub.ts`/`BaseAgent.ts`/`GraphFactory.ts`/三注册表/`merger.ts`/`maintainer.ts`/`drivePhases` 消息往返；DB 三张表导出归档；Java 20 文件（DTO/VO/entity/mapper/service/controller）删除；前端编排页下线
- 门：注入六类合成失败 → 路由正确；DB 迁移 SQL 附带且可回滚
- **验收**：代码量下降 ≥40%，控制流可在一个文件里读完

### M8｜前端运行报告 + 交付（3 天）
- 报告页：slice 状态 / 失败类 / 命令 / 退出码 / 证据链接 / 恢复按钮
- 团队视图由 `run_events` 渲染（角色 + 证据，替代"正在思考…"）
- **配色与 CSS 不改**（复用既有组件与变量）
- 门：不懂内部实现的人只看报告页能回答"哪里失败、为什么、下一步"
- **验收**：前端 `npm run build` 通过，视觉无回归

### M9｜切流 / 上线门 / 观察（2–3 天）
- 新流水线在 flag 后运行 → 对比评分卡 → 达标后切默认 → 删除 `legacy/`
- 上线门：冻结场景评分卡达阈值；所有失败路径显式；崩溃/超预算可恢复；**无静默降级**（告警数 = 0）
- 观察期：连续 N 次运行分数不下滑

**总工期**：约 5–6 周（单人 + 我）。M1 之后每个里程碑都可独立交付价值，可随时叫停。

---

## 5. 上线定义（Definition of Done）

对 3 个冻结场景，端到端无人干预达成：
1. 前端 `vite build` 退出码 0；
2. 后端在容器内启动成功且健康检查通过；
3. 契约测试全部断言通过（HTTP 状态 + JSON 字段）；
4. 页面渲染非白屏；
5. 需求覆盖清单逐条勾选；
6. 失败时输出**显式失败报告**（失败类 + 命令 + 退出码 + 证据），**永不静默 done**。

---

## 6. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Docker 冷启动/拉镜像耗时 | 验证分钟级 → 体验差 | 镜像预热 + 结果按 `inputHash` 缓存 + 编译不过不启动 |
| 弱模型在工具循环里耗尽轮次（p9 已实锤） | 整阶段 0 产出 | 轮次耗尽**退单发老路**；删掉"换个关键词"话术；预留写盘轮次；M6 起 implement 用 pro |
| 端点超卖（实测 443s 尾延迟） | 超时/截断 | 并发按端点容量定，宁串行 |
| 拆除 DB 控制平面影响 Java/前端 | 编译或页面断裂 | 独立提交 + 迁移 SQL + 前端页面先下线后删代码 |
| 重写期间不可交付 | 无可用版本 | strangler：新路径达标前旧路径保活 |
| 我无法验证的部分（真实 API 质量） | 结论失真 | 只声明我实际跑过的结果；不能跑的明确标注 |

---

## 7. 需要你提供或确认（仅此三项，其余我自行决定）

1. **成本口径**：D-9 把写代码工位升到 pro（质量优先）。若你要求控成本到某一档，给我上限数字，我据此调档。
2. **前端编排页下线**：D-5 会移除前端的节点/边编排页面（配色与 CSS 不动，只移除该功能入口）。确认可接受。
3. **桌面端/离线**：本计划只在 M2 提供 SQLite 抽象（低成本），**不做桌面打包**，直到上线门通过。若你要提前，请说明。

---

## 9. M0 实测与据此的计划调整（滚动更新）

### 9.1 基线实测（2026-09-10，零 LLM）

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | **退出码 0、零输出**（类型基线绿） |
| 零 LLM smoke（18 个） | **18/18 exit=0 全绿** —— 印证"测试证明管道不漏水，不证明产品能用" |
| 历史产物 p1 / p2 / p4 / p9 | 文件 53 / 74 / 140 / 45；**入口件 0/4 / 2/4 / 4/4 / 2/4**；测试报告 0 / 5 / 13 / **0** |
| p9 Java（21 个文件） | 真 javac + `-encoding UTF-8`：**语法错 0**、依赖/类型诊断 100（无 classpath，符合预期）、编码错 0 |
| p9 `pom.xml` | 已含 `<project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>` ✅ |

### 9.2 两条实测新发现

**F-1（工具陷阱，差点让我自己误判）**：本机 javac 默认按 **GBK** 读源码；生成的 `.java` 是 UTF-8 且含中文注释，于是每个中文注释都报 `unmappable character`。
→ 我第一次统计把它算漏了，得出"语法通过率 100%"的**假绿**。教训直接写进纪律：**闸门的"忽略规则"必须是白名单式的**——只忽略明确列出的诊断种类（依赖/类型），其余一律计入，未知种类**默认计入并报警**，绝不允许"没匹配上就是通过"。
→ 施工要求：Java 闸门必须显式传 `-encoding UTF-8`，并把 `unmappable` 单列为编码错误（不忽略）。

**F-3（决定性，2026-09-10 实机编译）**：用仓库 `mvnw` + 真实 classpath 编译 `runs/p9/backend` 的产物 →
**BUILD FAILURE，3 处编译错，全部是"幻觉 API"**（`SessionConfig.java`）：

| 位置 | 错误 | 性质 |
|---|---|---|
| `:233` | `JdbcIndexedSessionRepository` 构造器不匹配：需要 `(JdbcOperations, TransactionOperations)`，实传 `(JdbcTemplate)` | 模型按想象中的签名写代码 |
| `:237` | 不存在方法 `setPrincipalNameQueryColumnName(String)` | 纯幻觉 API |
| `:249` | 不存在方法 `setDeleteSessionsByPrincipalNameQuery(String)` | 纯幻觉 API |

**这一类缺陷对现有全部防线不可见**：语法没问题（我新加的 javac 语法闸门放行）、正则比对无关、六项纸审清单没有一项要求"这个方法真的存在"、渲染审只盖前端。**只有"真实 classpath 编译"能抓到它。**
→ 结论一：**M3 的 `mvnw compile` 不是"锦上添花"，而是质量链上唯一的缺口填补者**；语法闸门按原计划只作写盘前的廉价预筛。
→ 结论二：p9 里"看起来通过"的阶段，其产物**根本不可构建**——boot/HTTP/渲染在它之上都不可能成立。
→ 结论三（施工细节）：验证层必须区分 **ENV**（`Could not resolve dependencies`，本地 `~/.m2` 缺依赖，离线时实测复现）与 **COMPILE**（`COMPILATION ERROR` + 真实诊断）；且 Maven 输出在本机是 GBK，需 `-Dfile.encoding=UTF-8`（或英文 locale）才能稳定解析。
→ 附带发现：`LoginRequest.java:39` / `Admin.java:59` 报 `Not generating toString(): A method with that name already exists`（Lombok `@Data` 与手写 `toString()` 撞车），属代码质量瑕疵，归 T3 类（不阻断构建）。

**F-2（优先级重排）**：p9 的 Java **语法层面是干净的**（0 语法错）。也就是说，"静态语法闸门"虽然便宜，但**收益有限**——真正的质量缺口在**类型层面**（需要 classpath）与**运行时层面**（从未被执行过）。
→ 据此调整 M3：语法闸门降级为**写盘前的廉价预筛**；主线改为 `mvnw -o dependency:build-classpath` 拿真实 classpath → `mvnw compile`（真类型检查）→ 启动 → HTTP 契约。**F-3 已把它从"应该做"升级为"必须做"。**

### 9.3 成本轨（与 M1–M9 并行，全部可零 LLM 自测）

目标：**质量↑的同时把 LLM 成本压平或下降**。DeepSeek 的上下文缓存是**前缀命中**，因此所有杠杆都指向"前缀稳定化 + 调用次数下降"。

| # | 杠杆 | 预估收益 | 零 LLM 可测性 | 状态 |
|---|---|---|---|---|
| C-1 | **提示词装配顺序固化**（稳定段在前：角色/契约/骨架/基线；易变段在后：任务、文件路径、已写文件、反馈），同一 run 内同族调用的前缀**逐字节一致** | 缓存命中率↑（命中部分按缓存价计费） | ✅ 可写单测：断言同族调用前缀哈希一致 | ✅ **已落地** `engine/steps/promptPrefix.ts` + 16 断言 |
| C-2 | **小任务砍掉前置阶段**（后端 files<3 跳过伪代码；前端 files<2 跳过设计稿） | 任务级调用数 −30~40%（p9 是 6 任务 6 次伪代码） | ✅ 纯逻辑单测 | ✅ **已落地**（`SKIP_PSEUDO_MAX_FILES` / `SKIP_DESIGN_MAX_FILES`） |
| C-3 | **文件树块改为任务级快照**（不再随写盘增长）+ 4000 字符上限 | 同任务内后续调用前缀不失效 | ✅ 纯函数单测 | ✅ **已落地**（含截断显式标注） |
| C-4 | **工具循环预算化**：预算告警/硬令提前下发、宽限轮只许交付、`exitReason` 驱动退单发老路 | 最坏情况成本断崖下降 + 不再 0 产出 | ✅ 假模型脚本单测 | ✅ **已落地** `engine/exec/tool-budget-smoke.ts` 17 断言 |
| C-5 | **重试按成本而非按次数**：闸门打回优先 `edit` 补丁（工具模式已具备），legacy 路径逐步收敛 | 返工成本↓ | ✅ 假模型脚本单测 | ⬜ 待办 |
| C-6 | 档位调整（D-9：implement/repair→pro）必须与 C-2/C-4 同时上线 | 避免"质量↑但成本↑" | ✅ 配置单测 | ⬜ 待办（**需你确认成本口径**） |

### 9.4 C-4 的关键实现教训（写进纪律）

第一版实现只设了 `deliveryOnly` 标志而**没有提前告知模型**，结果模型在宽限轮仍然先调只读工具、被拒后就到点了——**宽限轮等于白送**。这个缺陷是被新写的 `tool-budget-smoke` 当场打回（4 条红）后才修正的。
→ 纪律：**任何"限制型"机制都必须在生效前显式告知**，否则等于没有；并且必须有一条断言覆盖"告知是否真的到达模型可见的上下文"。

**原则**：C-1 是所有杠杆的地基（前缀不稳，缓存全废）；C-4 是最大浪费的止血点。

---

## 8. 我承诺的施工纪律

- 每个里程碑**独立提交、可单独回滚**；仓库任何时刻保持可编译。
- 只声明实测结果；不能实测的（如真实模型产出质量）标注为"待你本地验证"。
- 密钥不入库、不入日志、不进提交。
- 前端配色与 CSS 零改动；若某改动必须触及前端，单独列出并先告知。
- 每个里程碑结束向你对账：改了哪些文件、验收结果、下一步。
