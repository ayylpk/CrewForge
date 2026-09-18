# 阶段 0 报告：旧系统可复核基线（before）

- 日期：2026-09-11
- 范围：`F:\code\project\CrewForge` / Agent 引擎 `agents-CrewForge` / 旧控制流**未改动**、旧代码**未删除**、技术栈未变（Vue 3 + Vite / Spring Boot 3 / MySQL 8）
- 机器基线：`eval/baseline/before.json`（76,203 字节，机器生成）
- 人类可读汇总：`eval/baseline/before.md`（26,196 字节，机器生成）
- 逐场景原始证据：`eval/baseline/runs/<场景>/{result.json,logs/}`
- 环境事实：`eval/baseline/env.json`

---

## 1. 一句话结论

> 用当前旧系统跑 3 个冻结场景：**没有任何一个达成端到端交付**（0 pass / 2 fail / 1 blocked，24 项真实检查 4 过 9 败 11 无法判定）。
> 但拿到了比"能不能交付"更有价值的东西：**每个失败都带命令、退出码、原始日志与根因**，
> 其中 3 个根因是"一击致命"级别（1 分钟内全灭 / 生成物根本起不来 / 失败占多数仍报完成）。

## 2. 环境事实（都是真跑命令得到的）

| 项 | 状态 | 证据 |
|---|---|---|
| bun | 1.3.14 可用 | 直连 `~/.bvm/runtime/v1.3.14/bin/bun.exe`；PATH 上的 `bun.cmd` shim 会报 `EPERM reading bvm-shim.js` |
| node / npm | 可用 | 网络可达 npm registry（HEAD 200） |
| java / javac | 17.0.18 (Adoptium) | `java -version` exit=0 |
| mvn | **全局没有** | 但 `~/.m2/wrapper/dists/apache-maven-3.9.16/.../mvn.cmd` 真实可用（wrapper 下过），harness 用这条路径 |
| Docker | **CLI 在，daemon 不在线** | `docker version --format {{.Server.Version}}` exit=1：`npipe:////./pipe/dockerDesktopLinuxEngine` 连不上 |
| MySQL | 可用（宿主） | `mysql2` 连 127.0.0.1:3306 + `SELECT VERSION()` 成功 |
| Redis | 未安装 | 引擎运行路径未使用 Redis（只在部署脚本里出现） |
| Edge | 装了，headless 可用 | 但**沙箱内被拒**（mojo 命名管道），需完整访问才能跑渲染判 |
| 模型端点 | 可达 | `POST https://api.deepseek.com/v1/chat/completions` → 200，model=`deepseek-flash`（配置读自 `sys_settings`） |

### 环境缺口对判定的影响（不是"通过"，也不是"失败"）

| 缺口 | 影响 |
|---|---|
| Docker daemon 不在线 | 旧系统 `finalGate → verifyRun` **必然**早退为 `skipped_unverified`：不构建、不启动、不打接口、不渲染。本 harness 改用**宿主 MySQL + 本机 Maven/JDK** 自己实测，把"交付是否成立"补齐为真实证据 |
| 沙箱拒绝子进程管道（`spawn EPERM`）与命名管道 | 所有真实命令执行（旧系统、npm、mvn、java、headless 浏览器）都必须在完整访问下运行；渲染断言在受限模式下只能是 blocked |

## 3. 三个场景的实况

### s1-crud-min（最小 CRUD 便签）—— 判定 `fail`

| 检查 | 结果 | 绑定证据 |
|---|---|---|
| frontend.build | **pass** | `npm run build` exit=0 |
| backend.build | **pass** | Maven 3.9.16 `package` exit=0 |
| backend.boot | **pass** | `java -jar` 起在 29817，`GET /api/notes` 返回 HTTP 200 |
| note.create / list / get / update / delete | **fail** | `code` 期望 200 实际 **0**；`data` 为 null；字段不存在 |
| note.getAfterDelete | **fail** | 期望 HTTP 404，实际 **200** |
| page.home（渲染） | **fail** | body 可见文本 0 字、无「便签」、无 `<input>` → 白屏 |

- 旧系统运行：**第 21 分钟人工止损**（`termination=manual`，exitCode=null，日志 30,159 字节，落库 `status=executing`，4 个任务全部没定论）
- 止损理由（机器事实）：测试工位对同一对任务**判负 4 次**，每次证据**逐字相同**——`渲染白屏：DOM 元素 8 个/可见文本 4 字`，零收敛
- 接口全红根因（应用日志原文）：`java.sql.SQLSyntaxErrorException: Table 'cf_eval_s1_crud_min.note' doesn't exist`
  → 生成物**没有任何建库/迁移机制**：`ddl.sql` 落在项目根目录无人执行，`backend/src/main/resources` 下只有 `application.yml`；
  → 且异常被包成 **HTTP 200 + `code=0`**，不是 5xx，所以"接口挂了"在外层看是"业务返回失败"
- 白屏根因（产物原文）：
  - 冻结需求：「只有一个路由 `/`」
  - `frontend/src/router/index.ts` 实际登记：`/note/create`、`/note/list` —— **没有 `/`**
  - 同一份 `CONTRACTS.md` 自己就写着「页面意向 便签管理页（路由 /）」，却在页面清单里登记成 `/note/list` —— 自相矛盾，而渲染审只回"8 元素/4 字"，不带 URL，返工 4 次都在改同一个 widget
- 额外机器证据（契约漂移）：引擎自己的验收 IR `_verify/acceptance-p1.json` 断言 `$.code === 1`，而冻结需求的统一响应体是 `{"code":200,...}`；`baseline.ts:52 `PROJECT_BASELINE.response.successCode = 1`。
  → 即使后端按需求返回 `code=200`，**引擎自己的交付关也会判它不通过**；这个漂移没进 `openQuestions`（没有 SPEC 类暂停）

### s2-auth（登录 / JWT）—— 判定 `blocked`（旧系统 1 分钟内崩溃）

- 旧系统运行：**exit=1，耗时 61.8 秒**，日志 stdout 只有 1,745 字节，产物 **0 文件**
- 落库：`status=planning`（**非终态**，没有 failed），`sys_task` **0 行**
- 崩溃根因（stderr 原文）：
  ```
  [llm:architectPlan] 第 1/3 次失败: Failed to parse. Text: "{"summary":"本阶段完成前后端工程骨架...
  [llm:architectPlan] 第 2/3 次失败: ...
  [llm:architectPlan] 第 3/3 次失败: ...
  error: Failed to parse ... lc_error_code: "OUTPUT_PARSING_FAILURE"
  ```
  → 架构师阶段规划的结构化输出**连续 3 次解析失败后抛出未捕获异常，整个进程退出**；没有降级、没有显式 failed、没有"换小 schema 重试"
- 所有后续检查因此 `blocked`（无产物可构建/启动/断言）——记为**无法判定**，不是通过，也不是失败

### s3-contract-mismatch（需求内部契约冲突）—— 判定 `fail`，且**系统自报 done**

- 旧系统运行：**exit=0，耗时 1,080,760ms（18 分钟）跑完 3 个阶段**
- 落库：`status=done`；任务 8 条 → **2 done / 6 failed**
- 交付关：`skipped_unverified（未验证）`——`Docker 不可用：无法起库与应用`（诚实标注，但 `status` 仍是 `done`）
- 真实检查：后端 Maven `package` **pass（exit=0）**，前端 `npm run build` **fail（exit=1）**，后端启动 **fail**，HTTP/渲染 **blocked（应用没起来）**
- 前端构建失败根因（vite 原文）：
  ```
  x Build failed in 52ms
  error during build:
  Could not resolve entry module "index.html".
  ```
  → 生成的 `frontend/` 目录**没有 `index.html`**（`p9` 的 `main.ts`/`App.vue` 缺失同型病，这次换成入口 HTML 缺失）
- 后端启动失败根因（Spring 原文）：
  ```
  ConflictingBeanDefinitionException: Annotation-specified bean name 'userController'
    for bean class [com.crewforge.user.controller.UserController...]
  ```
  → 生成了**两个简单类名相同的类**（不同包同名），Spring 组件扫描直接起不来。**Maven 能打包成功、编译能过，但服务一秒都活不了**
- 日志派生观测（只作观测、不参与判定）：LLM 重试尝试 5 次、含「失败」行 11 行

## 4. 三个场景的横向对照

| | s1-crud-min | s2-auth | s3-contract-mismatch |
|---|---|---|---|
| 旧系统 exit | null（人工止损） | **1（崩溃）** | 0（跑完） |
| 耗时 | 21 分钟（未跑完） | **62 秒（崩溃）** | 18 分钟 |
| 落库终态 | executing | **planning（非终态）** | **done** |
| 任务定论 | 0/4 | 0/0（根本没拆） | 2 done / **6 failed** |
| 产物文件 | 58 | **0** | 76 |
| 前端 build | ✅ exit=0 | — | ❌ exit=1 |
| 后端 build | ✅ exit=0 | — | ✅ exit=0 |
| 后端启动 | ✅ HTTP 200 | — | ❌ 起不来 |
| 接口断言 | ❌ 0/6 | — | 无法判定 |
| 渲染断言 | ❌ 白屏 | — | 无法判定 |
| 假通过 | 否 | 否 | 否（但 **done + 6 failed + 未验证**） |

## 5. 当前系统最先应该修的三个问题

### ① 结构化输出解析失败不许杀进程（s2：62 秒全灭）

- 事实：`architectPlan` 解析失败 3 次 → 未捕获异常 → `exit=1`；项目停在 `planning`、零任务、零产物。
- 为什么排第一：**这是唯一一个"什么都没产出"的失败模式**，而且它把失败留成了非终态（控制流无法恢复，对账器只会反复重拉）。
- 修法方向：解析失败必须走机器可分类的失败路径（`SPEC`/`COMPILE` 类 + 显式 `failed` 落库 + 可读报告）；schema 过大时降级分块或换更小 schema 重试；**绝不允许"解析错误"直接冒泡成进程退出**。
- 复现：`bun run eval/runner.ts --scenario s2-auth --timeout-min 5`

### ② 生成物必须自带"能起来"的最小自举（s1 全接口红、s3 起不来）

- 事实：s1 空库启动后每个业务接口都撞 `Table '...note' doesn't exist`（`ddl.sql` 无人执行）；s3 前端没有 `index.html`（vite 直接失败）、后端两个同名 `UserController` 导致 Spring 启动异常。
- 为什么排第二：**"编译/打包通过"与"服务能用"之间现在是断的**——`mvn package` 成功（s3 exit=0）却一秒都起不来，而唯一能发现它的渲染审还是在用"元素数/文本量"这种间接指标。
- 修法方向：引擎拥有件补齐（`index.html`、迁移文件 `schema.sql`/Flyway、`Application` 入口）+ 写盘前**机械拒绝**同名类/重复 bean 名 + 把"能启动 + 主流程接口 200"前移到任务级验证（而不是只在 run 末端的 finalGate）。
- 复现：`bun run eval/runner.ts --scenario s1-crud-min --reuse-run`

### ③ "完成"必须等于"验证通过"，失败占多数绝不 done（s3：8 任务 6 失败仍报 done）

- 事实：s3 落库 `status=done`，同时 8 个任务里 6 个 `failed`、交付关因 Docker 不可用只给 `skipped_unverified`。
- 为什么排第三：**它直接决定"能不能信这个系统"**。现在前端 build 失败、后端起不来，看板仍然显示"完成"。
- 修法方向：`done` 的前置条件收成硬条件（全部任务定论且非 failed + 交付关 `verified=true` + 真实 build/boot/接口证据齐全）；`0 产物 / 0 任务 / 失败任务 > 0` 一律显式 `failed` 并出报告；`skipped_unverified` 落库不许写成 `done`（或至少用独立状态值）。
- 复现：`bun run eval/runner.ts --scenario s3-contract-mismatch --reuse-run`

> 附：`code=200 vs code=1` 的契约漂移（s1 的 `acceptance-p1.json` 断言 `$.code===1`）建议与 ③ 一起修——
> 它是"判据与需求脱钩"的同一类病：**验收 IR 必须从冻结需求生成，不能从引擎内置默认值长出来**。

## 6. 下一阶段能进入"单栈真实垂直闭环"吗？

**结论：具备开工条件，但目前不具备"能跑通"的系统条件。**

已经具备的（可直接复用，不必重做）：

- **尺子**：3 个冻结场景 + `expected.json` + harness 已能产出四段真实证据（build / boot / HTTP / render），每一条 `pass` 都由 `assertPassIsBound()` 强制绑定命令与退出码；
- **环境**：MySQL、JDK17 + Maven（wrapper 发行版）、Edge headless、`deepseek-flash` 端点全部在位；`bun x tsc --noEmit` exit=0；脚本可重复执行（`--reuse-run` 可只重跑检查不重烧模型）；
- **对照点**：`before.json` 已入库，改代码后可直接比分数。

还缺的前置（建议作为下一阶段入口验收）：

1. Docker daemon 起不来 → 旧系统 run 级验证永远 `skipped_unverified`。要么把 Docker 起起来，要么按本阶段已验证可行的方式（宿主 MySQL + 宿主 JVM，s1 已实测启动成功）改造 `verifyRun` 的落库方式；
2. 上面三个问题至少修掉 ①②（否则任何场景都跑不到"能判定"这一步）；
3. "返工环路"缺收敛判据与预算止损：s1 的同一失败签名重复 4 次、逐字相同，说明既没有"证据不变即换策略"，也没有"重复 N 次即停"；
4. 渲染审要带上下文（URL/路由/期望文案）。当前只回"8 元素/4 字"，模型拿不到可操作信息，返工只能瞎改。

**建议的下一阶段第一条验收**：在 `s1-crud-min` 这一个场景上，把 10 项检查从 **3 过 7 败** 推到 **10 过 0 败**，全程无人干预，且 `status=done` 必须伴随 `verified=true`。

## 7. 诚实声明（本阶段自己的问题）

- **没有端到端跑通任何场景**——本报告不声称"端到端完成"；Docker 不可用，旧系统的交付关在 3 个场景里一次都没真正执行过。
- **harness 自身修了 3 个缺陷**（都由真实执行暴露，非纸面推断）：
  1. Maven 回退路径算错（多算两级）→ s1 首轮"后端构建 blocked"是**假阴性**，修正后实测 **pass**；
  2. Windows `cmd.exe /c "带引号命令"` 被 Node 转义成 `\"`，命令根本没跑 → s3 首轮两个 build "fail" 是**假阴性**，修正后实测后端 **pass**、前端 **exit=1 真失败**；
  3. 渲染判据把 `<title>` 文本算进"可见文本"，会把白屏算成"有 4 个字" → 已改为只统计 `<body>` 可见文本（s1 首轮"便签"断言因标题侥幸通过，修正后暴露为真白屏）。
  → 上述修正只重跑了**检查**（`--reuse-run`），没有重跑任何一次旧系统流水线；两次修正前后的原始数据都留在 `runs/*/logs/`。
- **拿不到的数据如实置空**：旧系统不统计 token 用量、不自报重试次数 → `tokenUsage.available=false`、`retries=null`，另附"日志正则派生计数"并明确标注**不参与判定**。
- **未能验证的项**：3 个场景的 HTTP 契约断言里，只有 s1 真正打到了接口（0/6 通过）；s2/s3 的应用没能起来，因此它们的接口断言是 `blocked`（无法判定），**不是失败也不是通过**。
