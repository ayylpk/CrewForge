# CrewForge 完整项目蓝图与施工图

版本：v1.0  
日期：2026-09-11  
性质：架构蓝图、边界协议、施工顺序和验收标准  
适用范围：CrewForge 平台、agents-CrewForge 引擎、生成项目、桌面端本地修复器 testAgent

> 本文是施工图，不是“已经全部完成”的宣传稿。文中凡标记为“当前”均来自仓库代码、阶段报告和已保存的真实证据；凡标记为“目标”均是后续要实现的设计。目标没有通过真实命令、HTTP 或渲染证据前，不能写成 done 或 verified。

---

## 0. 先给结论

CrewForge 不再以“几个 Agent 在聊天里互相转发消息”为核心。正确的产品形态是：

> 用户给出需求，CrewForge 把需求冻结成结构化规格，选择一个可验证的技术栈，生成可运行项目，真实构建、启动、打接口、渲染，失败时只把机器证据交给修复 Agent，最后输出可审计的交付证据。

最终分工只有一句话：

| 角色 | 负责什么 |
|---|---|
| LLM | 分析、提出计划、补充契约、写业务代码、根据失败证据提出补丁 |
| Orchestrator | 调度步骤、控制状态、限制预算、恢复崩溃、决定是否继续 |
| Template/Stack Registry | 提供已验证的技术栈、骨架、依赖、命令和已知边界 |
| Verifier | 真正执行 build、boot、migration、HTTP、render，产出 Evidence |
| Ledger | 记录步骤、租约、重试、token、耗时、输入输出哈希 |
| testAgent | 在用户本机的项目目录内修复环境或代码，不拥有最终裁判权 |
| 人 | 只处理真正改变范围、验收、安全、环境的决策，不处理命名笔误 |

最重要的架构判断：

1. 代码正确性不能由正则、LLM 自述或“看起来像对”决定，只能由真实证据决定。
2. 技术栈、骨架、路由和数据库模型不能由模型自由发明，必须由版本化 StackProfile 和 Contract IR 约束。
3. 一个项目只能有一个状态事实源。运行期间以 Ledger 为准，产品数据库只保存索引和报告摘要，不能两边各自推进状态。
4. done 只能表示所有必要证据已通过；“生成了文件”“编译过了”“模型说完成了”都不等于 done。
5. 真实 LLM 调用是发布候选验证，不是日常单元测试。绝大多数测试必须零 LLM。

---

## 1. 当前系统的真实边界

### 1.1 仓库组成

当前仓库不是一个单体程序，而是四个边界不同的部分：

~~~text
CrewForge/
├─ agents-CrewForge/           TypeScript + Bun：旧团队、engine、engine2、评测
├─ backed-CrewForge/           Java Spring Boot：产品后端、项目/任务/运行报告 API
├─ fronted-CrewForge/          Vue 3 + Vite：控制台、项目、任务、运行报告页面
├─ runs/                       每次生成项目和验证 Evidence 的留档
├─ docs/                       设计、计划、阶段报告
└─ F:/code/agent/testAgent     独立仓库：用户本机终检/修复 Agent
~~~

### 1.2 旧控制平面（保留，但不再作为新流程核心）

旧系统仍包含：

- Hub、BaseAgent、GraphFactory、Node、DB 节点/边；
- manager、architect、backendEngineer、frontendEngineer、testEngineer；
- merger、maintainer、projectRunner；
- 以消息往返、内存缓存和文本 CONTRACTS.md 为主的控制流。

这些代码暂时保留是为了兼容旧项目、做前后对照和渐进切流，不代表新项目继续依赖它们。engine2 的代码不得 import Hub、BaseAgent、GraphFactory、merger、maintainer，也不得回到“消息恰好到达才算推进”的模式。

### 1.3 engine2 当前能力

agents-CrewForge/engine2 已经具备以下基础：

- 显式 Orchestrator；
- SQLite Ledger、步骤幂等、租约回收、崩溃恢复；
- Fake LLM 异常模式；
- Spec、Plan、Contract 的结构化输出；
- 引擎骨架、文件 ownership；
- 前端 build、后端 Maven build、启动、数据库初始化、HTTP 契约、渲染和 Evidence；
- 预算、失败签名、重试停止；
- CLI 和 HTTP 项目入口；
- 报告落盘和产品后端报告 API 接线。

这些是代码能力，不等于真实模型已经稳定地产出正确项目。

### 1.4 最近一次真实 smoke 的结论

证据文件：

- runs/llm-smoke/evidence.json
- runs/llm-s1-gen/_engine2/evidence.json
- runs/llm-s1-gen/_engine2/logs/frontend-build.log
- runs/llm-s1-gen/_engine2/logs/app.log

当前真实模型第一类调用的事实：

| 层 | 结果 | 证据 |
|---|---|---|
| 必需文件 | 通过 | 文件齐备 |
| 后端 build | 通过 | mvnw package exit=0 |
| 后端 boot | 通过 | 应用启动 |
| 数据库初始化 | 通过 | schema.sql 执行出 1 张表 |
| 前端 build | 失败 | notes.ts 中 createNote/getNote/updateNote/deleteNote 重复导出 |
| HTTP | 9/10 失败 | 服务访问 notes 表，但 schema.sql 创建的是 note 表 |
| render | 未执行 | 前端没有 dist |
| 终态 | paused/failed，verified=false | 没有伪造 done |

这次不能归结为“模型粗心”：

1. 前端重复导出是生成产物缺陷，写盘前应由 TypeScript/ESBuild 闸门抓住。
2. note 与 notes 的不一致暴露了引擎骨架、契约和业务实现之间没有共享唯一数据模型。这是平台边界缺陷，不能只让模型“下次注意”。
3. 当前停止在第一类失败、没有继续烧第二类和第三类调用，是正确的成本纪律。

因此，在修复以下平台缺口前，不批准第二条技术栈：

- canonical data model：实体名、物理表名、字段和迁移由一个 IR 产生；
- 生成文件不能以追加方式重复写入同一导出；
- 每个 slice 写盘前必须执行真实的语言/框架静态闸；
- HTTP 失败必须能看到应用原始日志和数据库状态；
- realLlm 调用计数必须在发请求前落账；
- assumptions 与真正阻塞的 openQuestions 必须分开。

---

## 2. 产品目标、非目标和成功定义

### 2.1 产品目标

CrewForge v1 要做到：

1. 用户提交一句或几段自然语言需求；
2. 系统把需求保存为不可篡改的 RequirementSnapshot；
3. 系统从已注册 StackProfile 中选出可运行技术栈；
4. 系统直出框架骨架、启动文件、迁移入口和必要的共享文件；
5. LLM 只实现声明过的业务 slice；
6. 系统用真实命令和真实服务验证；
7. 对编译错误、HTTP 错误和测试错误分别做有界修复；
8. 输出项目文件、差异、日志、命令、退出码、HTTP 断言和渲染证据；
9. 用户可下载项目，也可用桌面端在本机继续修复。

### 2.2 非目标

v1 不做以下事情：

- 不保证任意复杂需求都能一次生成；
- 不让模型任意选择未注册的框架；
- 不把 LLM 当最终测试裁判；
- 不把用户机器的 Docker socket 暴露给远程服务；
- 不把所有模板源码塞进 MySQL 作为唯一真相；
- 不用无限重试掩盖需求不清或架构不支持；
- 不在一个阶段同时推进多条未验证技术栈；
- 不为“多 Agent”增加无边界角色和聊天动画；
- 不把 testAgent 变成服务器端万能脚本执行器。

### 2.3 成功定义

对一个冻结场景，只有同时满足下列条件，项目才是 done：

1. RequirementSnapshot、Spec、Plan、Contract、StackProfile 版本齐全；
2. 至少一个 slice 和一个真实产物存在；
3. 没有 failed slice、failed step 或未处理的违规写盘；
4. 前端依赖安装和 build exit=0；
5. 后端 build exit=0；
6. 后端启动并通过健康检查；
7. 数据库迁移/建表在干净临时库执行成功；
8. 所有必需 HTTP 用例状态码和字段断言通过；
9. 页面真实渲染通过，不是“跳过渲染”；
10. Evidence 新鲜，哈希对应本次输入和本次产物；
11. 产物、日志、命令、退出码、token 和修复次数可追溯。

环境不可用只能是 blocked 或 skipped_unverified，不能转成 done。

---

## 3. 目标总架构

### 3.1 三平面架构

~~~text
┌─────────────────────────────────────────────────────────────────────┐
│ 产品平面：backed-CrewForge + fronted-CrewForge                     │
│ 用户、项目、需求、运行按钮、实时事件、报告、设置、权限              │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ HTTP/SSE
┌──────────────────────────────▼──────────────────────────────────────┐
│ 编排平面：agents-CrewForge/engine2                                 │
│ Requirement → Spec → Stack → Plan → Contract → Implement → Verify │
│ Orchestrator + Ledger + Workspace + LLM Gateway + Classifier        │
└───────────────┬──────────────────────────────┬───────────────────────┘
                │ 生成项目/修复请求               │ Evidence/报告
                ▼                              ▼
┌──────────────────────────────┐   ┌──────────────────────────────────┐
│ 执行隔离层                    │   │ 用户本机桌面端                    │
│ Docker 或受控宿主验证         │   │ Tauri 2 壳 + testAgent sidecar    │
│ MySQL/应用/前端临时进程       │   │ 本地文件、命令、差异、修复、证据    │
└──────────────────────────────┘   └──────────────────────────────────┘
~~~

### 3.2 两类数据流

控制流：

~~~text
用户需求
  → RequirementSnapshot
  → Spec + assumptions
  → StackDecision
  → Plan/Slices
  → Contract IR
  → 骨架
  → 业务实现
  → Verification
  → Repair（必要时）
  → Completion
~~~

证据流：

~~~text
每个命令/请求/渲染动作
  → exitCode / HTTP status / stdout / stderr / DOM / screenshot
  → Evidence item
  → evidenceHash
  → Failure classification
  → Ledger + run report + 产品报告页
~~~

控制流不能通过“读日志猜成功”倒推；证据流不能被 LLM 改写。

### 3.3 组件职责

| 组件 | 输入 | 输出 | 严禁 |
|---|---|---|---|
| Product API | 用户、项目、运行操作 | 权限校验后的命令/查询 | 直接修改 Ledger 状态 |
| Orchestrator | 快照、Profile、LLM 接口、验证器 | 状态迁移、步骤事件、完成结论 | 读取模型自述作为通过 |
| LLM Gateway | 边界名、结构化 prompt | 结构化响应、用量、原文 | 静默换模型、漏记失败请求 |
| Stack Registry | profile id/version | 骨架、命令、环境、能力 | 运行时让模型临时改 profile |
| Contract Compiler | Spec、Plan、数据模型 | Contract IR、路由清单、HTTP cases | 从散文正则猜接口 |
| Workspace | 写盘请求、owner、白名单 | 原子写入、拒绝原因 | 允许引擎件被任务覆盖 |
| Verifier | 项目目录、Contract、Profile | Evidence、VerifyResult | 用静态猜测替代真实执行 |
| Ledger | run/step/event/usage | 可恢复状态和审计账 | 只在内存计数 |
| testAgent | RepairRequest、本地项目 | RepairResult、diff、重跑证据 | 修改 allowedRoots 外文件 |
| Report | Ledger、Evidence | 人可读报告、机器 JSON | 重新判定业务正确性 |

---

## 4. Agent 团队设计：少角色、硬边界

### 4.1 角色不是聊天对象，而是能力边界

目标最多七个可配置 LLM 边界。默认关闭 Advisor，Skeleton 完全由代码生成，不消耗 LLM：

| 边界 | 是否必须 | 作用 | 机器权威 |
|---|---:|---|---|
| analyze | 是 | 把原始需求转为 Spec 和 assumptions | RequirementSnapshot、expected.json |
| stackAdvisor | 否 | 给出 Profile 候选和风险说明，只能 hold | Stack Registry |
| plan | 是 | 生成 slice、依赖、文件声明 | ownership、Profile 能力 |
| contract | 是 | 补充页面/共享模块描述，不能改变冻结接口 | Contract IR |
| implement | 是 | 在一个 slice 的 allowed files 内实现 | 编译闸、写盘闸 |
| repair | 按需 | 根据机器失败证据做局部修复 | 原失败证据、重跑结果 |
| report | 否/低频 | 把事实整理给人看 | Ledger/Evidence |

### 4.2 Agent 通用协议

所有 LLM 边界都必须：

- 输入带 runId、requirementHash、stackProfileDigest、contractHash、预算；
- 输出是严格 JSON，解析失败分类为 OUTPUT_PARSING_FAILURE，不得杀进程；
- 不能输出 verified、done、pass 等权威结论；
- 不能改变 expected.json、Contract IR、StackProfile、Evidence；
- 不能写盘，写盘必须回到 Workspace；
- 不能访问 workspace 以外的文件；
- 必须回传 model、inputHash、promptTokens、completionTokens、durationMs；
- 失败请求在发起前就递增 calls，超时和空响应也必须记账。

### 4.3 analyze 的正确行为

Spec 至少包含：

~~~text
Spec {
  goal,
  entities[],
  endpointsExpected[],
  pagesExpected[],
  constraints[],
  assumptions[],
  openQuestions[],
  analysisPolicy,
  sourceRequirementHash
}
~~~

实现细节的可保守默认值进入 assumptions，例如日期格式、列表排序、PUT 是全量还是部分更新。真正阻塞的问题才进入 openQuestions：

- 改变验收结果；
- 改变功能范围；
- 需求内部矛盾；
- 安全、隐私或数据丢失风险；
- 技术栈或环境不可行。

冻结场景使用 analysisPolicy=frozen_scenario：expected.json 是路径、方法、状态码、页面路由的权威来源。模型不得重新发明 PUT、首页路径或成功码。

交互项目使用 analysisPolicy=interactive：关键问题最多澄清两轮；相同问题指纹重复出现时立即暂停，不得无限烧钱。

只在 prompt 里写“openQuestions 必须为空”是不够的；分类器、数据结构和测试必须共同约束行为。

### 4.4 plan 的正确行为

Plan 只负责功能竖切，不负责发明框架：

~~~text
Slice {
  id,
  kind: backend-api | frontend-page | worker | migration,
  feature,
  files[],
  endpointIds[],
  pageRoutes[],
  dependsOn[],
  allowedRoots[]
}
~~~

规则：

- 一个 feature 的前后端可以成对，但不强迫纯后端/迁移任务伪造前端；
- 一个页面的路由、页面组件、页面 API 调用属于同一 feature；
- router、入口、pom、package.json、schema/migration 等引擎件由 Skeleton/Contract 负责；
- 同一个文件只能有一个 owner；
- 计划文件路径必须和真实 workspace 路径一致，不能出现 backend/app 双根或包名漂移。

### 4.5 contract 的正确行为

Contract 编译器以 Spec 和 StackProfile 为输入，产出：

- contract.json；
- route-manifest.json；
- backend-endpoints.md；
- http-cases.json；
- 前端 API 文件；
- 任务可消费的 contract prompt block。

HTTP 端点、页面路由、状态码和核心字段来自冻结需求/expected.json。LLM 只能补充页面文案、组件关系和共享模块说明；如果它修改权威字段，机器拒绝。

### 4.6 implement 的正确行为

实现 Agent 每次只接收一个 slice：

- 当前 slice 的 Spec、Contract、Profile；
- 该 slice 的 allowedRoots 和 plannedFiles；
- 相关引擎生成文件的只读摘要；
- 现有文件内容；
- 失败时附真实 evidence；
- 明确的完成条件是“写入后再次验证”，不是“我已经写好了”。

实现 Agent 不得：

- 写 _engine2、_verify、contract.json、route-manifest、Evidence；
- 修改其他 slice 的文件；
- 修改 CrewForge 源码或 testAgent 自身；
- 通过文本替换修改不唯一的锚点；
- 用全文件追加代替原子覆盖；
- 引入 Profile 不允许的依赖。

### 4.7 repair 的正确行为

RepairRequest 只包含：

~~~text
runId
sliceId
failureCategory
failureSignature
changedFiles
contractHash
evidence[]        // 命令、退出码、stdout、stderr、HTTP/DOM
allowedRoots[]
budget
~~~

Repair Agent 只能修受影响 slice，最多初始生成后两次修复。相同 failureSignature 且文件内容没有变化时，不再调用模型。环境类错误不调用 repair，直接转人工/blocked。

---

## 5. 技术栈与模板系统

### 5.1 StackProfile 是唯一栈真相

StackProfile 不是模型返回的一段文字，而是带版本和摘要的可执行配置：

~~~text
StackProfile {
  id: "spring-vue-mysql",
  version: "1.0.0",
  runtime: { java: "17", node: "22", bun: "1.3" },
  frontend: { framework: "Vue 3", bundler: "Vite", commands: [...] },
  backend: { framework: "Spring Boot 3", build: "Maven", commands: [...] },
  database: { engine: "MySQL 8", migration: "schema.sql + versioned migrations" },
  components: [...],
  skeletonFiles: [...],
  engineOwnedFiles: [...],
  validators: [...],
  env: [...],
  capabilities: [...],
  knownLimits: [...],
  templateDigest: "sha256:..."
}
~~~

Profile 必须声明：

- 可以生成什么；
- 不支持什么；
- 如何安装、构建、启动和健康检查；
- 如何初始化数据库；
- 哪些文件引擎拥有；
- 哪些组件/依赖是白名单；
- 失败应归 COMPILE、CONTRACT、ENV 还是 SPEC。

### 5.2 栈选择算法

选择顺序固定：

~~~text
需求解析
  → 硬约束提取（语言、数据库、部署环境、已有仓库）
  → Profile capability 过滤
  → deterministic score 排序
  → 可选 stackAdvisor 给建议/风险
  → 若无唯一可行栈则暂停
  → 固化 stackDecision(profileId, version, digest, reason)
~~~

Advisor 只有 hold 权，不能创建新 Profile，不能越过硬约束。需求写“Node + TypeScript”时，模型返回 Spring Boot 必须被代码拒绝，不靠自觉。

### 5.3 模板如何存

推荐“Git 文件为源、数据库存索引”的双层方案：

~~~text
agents-CrewForge/engine/stacks/profiles/
└─ spring-vue-mysql/
   └─ 1.0.0/
      ├─ profile.json
      ├─ template-manifest.json
      ├─ frontend/
      ├─ backend/
      ├─ database/
      └─ README.md
~~~

数据库只存：

- profile id/version/digest；
- 可用能力和组件；
- 文件描述、owner、扩展点；
- 构建/启动/迁移命令；
- 是否已验证、验证时间、验证报告地址。

不要把模板代码只存进 MySQL。代码放 Git 可审查、可 diff、可回滚；数据库描述用于检索、展示和 prompt 注入。

### 5.4 模板注释和描述协议

模板文件头部可以带机器可读注释：

~~~text
@cf-template spring-vue-mysql@1.0.0
@cf-owner engine
@cf-role backend-runtime
@cf-contract entity=note table=note
@cf-extension business-slice=note
~~~

同时由 template-manifest.json 给出：

- file path；
- description；
- generated/engine-owned/extension；
- allowed edit regions；
- dependsOn；
- expected exports/routes/tables；
- 可供 LLM 读取的短说明。

注释只帮助模型理解，最终限制由 manifest、Workspace 和 Verifier 执行。

### 5.5 第一阶段和后续栈

第一阶段只冻结：

~~~text
Vue 3 + Vite
Spring Boot 3 + Java 17 + Maven
MySQL 8
~~~

第二阶段一次只加入一个 Profile，例如：

1. Node.js + TypeScript + Fastify/Express + MySQL；
2. FastAPI + Python + MySQL/PostgreSQL。

每条新栈必须先通过“骨架可构建、可启动、迁移可执行、一个最小 HTTP 场景可过”的 Profile Gate，再允许模型使用。

---

## 6. 唯一数据模型：解决 note/notes 类事故

### 6.1 Canonical Domain IR

实体、物理表、字段、请求和响应必须来自一个 Domain IR：

~~~text
DomainModel {
  entity: "note",
  table: "note",
  id: { name: "id", type: "long", generated: true },
  fields: [
    { name: "title", type: "string", nullable: false, maxLength: 200 },
    { name: "content", type: "text", nullable: true },
    { name: "createdAt", column: "created_at", type: "timestamp" }
  ],
  naming: { java: "Note", typescript: "Note", table: "note" }
}
~~~

由同一个 IR 生成：

- schema.sql 和迁移；
- Java entity/DTO/SQL；
- TypeScript 类型和 API；
- HTTP request body；
- 验收字段；
- 页面表单。

如果模型想使用 notes 而 canonical table 是 note，写盘闸或集成验证必须明确拒绝/报错，不等到九个 HTTP 全部 500 才发现。

### 6.2 生成约束

- SQL 查询不得引用未在 Domain IR 中声明的表；
- schema.sql 中必须存在所有必需表和字段；
- 物理表名变更必须通过 migration 版本，不允许实现 Agent 自行改名；
- 查询字段、响应字段和前端类型必须能从同一字段映射得到；
- 空库启动时必须执行 schema/migration，不能依赖“用户手工先建表”；
- seed 数据和 HTTP fixture 必须声明来源。

允许使用简单静态扫描作为“早期诊断”，但最终仍由真实迁移和 HTTP 验证裁决。

---

## 7. 生成流水线施工图

### 7.1 一次 run 的完整顺序

~~~text
1. 创建 run，冻结 RequirementSnapshot
2. 读取/校验 StackProfile
3. analyze → Spec + assumptions/openQuestions
4. 有阻塞问题：paused(SPEC)，不生成业务代码
5. plan → Slices + ownership
6. contract → Contract IR 和渲染物
7. skeleton → 程序直出引擎文件
8. domain compile → canonical Domain IR、schema、migration
9. implement → 每个 slice 原子写盘
10. 写盘后静态闸：语言语法、import/export、路径、ownership
11. run verifier：
    files → frontend build → backend build → boot → migration
    → HTTP contract → render → evidence save
12. 失败分类
13. 可修复：只对受影响 slice 调 repair，最多两次
14. 同签名无变化：立即停止
15. 通过：生成 completion.json 和 run-report.md
16. 汇总到产品 API，允许下载/打开桌面端
~~~

### 7.2 骨架直出清单

Skeleton 是程序代码，不调用 LLM。每个 Profile 自己声明骨架清单，至少包含：

- 前端 package.json、index.html、main、router、App、基础样式；
- 后端 pom/build 文件、Application、application.yml；
- 数据库连接配置和 migration 入口；
- canonical Domain IR 对应的 schema/migration；
- 健康检查端点；
- 契约渲染的 API 文件；
- 一页最小可渲染页面。

骨架模板自身必须有真 build smoke。骨架 build 过不代表业务实现正确，但骨架 build 不过时不得消耗业务 LLM。

### 7.3 写盘协议

所有写入统一经过 Workspace.write：

~~~text
WriteRequest {
  runId,
  taskId,
  path,
  content,
  mode: create | replace | patch,
  owner,
  expectedHash?
}
~~~

机械规则：

- 真实路径必须在项目目录内；
- _engine2、_verify、Profile 生成的引擎件拒绝任务写入；
- path 必须在 slice plannedFiles/allowedRoots；
- 同一文件只能有一个 owner；
- replace 必须原子写临时文件后 rename；
- patch 必须 old 匹配一次，零次或多次都拒绝；
- 写入后先过对应静态闸，失败不提交；
- 每次写入记录旧哈希、新哈希、taskId、attempt。

这样可以直接阻止“同一文件重复 append 导出函数”的路径；即使模型输出仍重复，ESBuild 闸会在提交前给出原文错误。

---

## 8. 验证器和 Evidence

### 8.1 九步顺序

~~~text
files_exist
  → frontend_install/build
  → backend_build
  → backend_boot/health
  → db_migration_init
  → http_contract
  → render
  → evidence_saved
  → completion decision
~~~

前一步失败时，后一步不得伪执行。比如前端 build 失败，render 必须写“未执行”，不能写 pass。

### 8.2 Evidence 最小结构

~~~text
Evidence {
  runId,
  requirementHash,
  stackProfileDigest,
  artifactHash,
  step,
  command,
  args[],
  cwd,
  exitCode,
  stdout,
  stderr,
  durationMs,
  httpStatus?,
  request?,
  response?,
  domSummary?,
  screenshot?,
  startedAt,
  finishedAt
}
~~~

Evidence 由 Verifier 生成，LLM 只能读取。报告必须同时保存原文日志和摘要，摘要不是证据替代品。

### 8.3 HTTP 验证

HTTP cases 从 Contract IR 生成，不从 task.description 行式正则解析。每个 case 必须包含：

- id；
- method/path；
- request body；
- expected HTTP status；
- JSON 字段谓词；
- 前置数据/捕获变量；
- 清理动作。

请求顺序必须能覆盖 create/list/get/update/delete/not-found/post-delete。HTTP 200 包着业务错误不能被误判成成功，必须同时断言 HTTP 状态和响应 envelope。

### 8.4 渲染验证

页面渲染用真实浏览器或已声明的替代工具：

- 真实访问 / 或 Contract route；
- 等待应用脚本执行；
- 采集 DOM 摘要、关键文案、元素数量、截图；
- 空 DOM、无关键元素、构建未通过都不是 pass；
- 浏览器不可用属于 ENV/未验证，不得假绿。

---

## 9. 状态机、Ledger 和恢复

### 9.1 状态分层

~~~text
Project: draft → planning → running → paused | failed | done | blocked
Run:     created → running → paused | failed | done | blocked
Slice:   planned → contracted → implemented → verifying → verified
                                      └──────────────→ failed
Step:    queued → leased → running → ok | failed | skipped
~~~

所有状态迁移经过一个函数校验。任何异常都必须落终态或明确 blocked，不允许进程退出后项目仍停在 executing/planning 而没有恢复信息。

### 9.2 Ledger 表

每个 run 至少需要：

- runs：runId、projectId、status、requirementHash、profileDigest、startedAt、finishedAt；
- steps：stepId、kind、sliceId、inputHash、status、leaseUntil、resultHash、error；
- slices：sliceId、status、attempts、owner、artifacts；
- events：顺序号、类型、payload、时间；
- failures：category、signature、inputHash、evidenceHash、changedFiles、attempt；
- usage：边界、模型、请求开始时刻、prompt/completion tokens、cost、duration、ok；
- artifacts：路径、owner、hash、大小、createdBy。

SQLite WAL 是单 run 执行事实源；产品 MySQL 只接收可查询摘要和报告地址。

### 9.3 重试和熔断

- 初始实现 1 次，修复最多 2 次；
- 相同错误签名且 changedFiles 不变，立即停止；
- 每 run、每 slice、每角色有独立 token/时间预算；
- COMPILE、CONTRACT、TEST 可调用 repair；
- ENV 不调用 repair；
- SPEC 必须暂停或转人工；
- BUDGET 立即停止，输出已花费和未完成项；
- retryCount 必须来自 Ledger，不得继续使用内存 Map。

---

## 10. testAgent 与桌面端蓝图

### 10.1 testAgent 的定位

testAgent 不是远程裁判，也不是让服务器任意执行用户机器命令的后门。它是：

> 用户授权后，在用户本机的项目目录内，根据真实错误证据做受限修复，并重新执行原验证命令。

它只返回 pass / fail / incomplete / error，依据是重新执行命令的结果，不是模型自述。

### 10.2 RepairRequest/RepairResult

~~~text
RepairRequest {
  requestId,
  projectPath,
  stackProfile,
  failureCategory,
  failureSignature,
  evidence[],
  commands[],
  allowedRoots[],
  forbiddenPaths[],
  maxIterations,
  requiresUserApproval[]
}

RepairResult {
  requestId,
  verdict: pass | fail | incomplete | error,
  changedFiles[],
  diffHash,
  commandEvidence[],
  remainingIssues[],
  iterations,
  startedAt,
  finishedAt
}
~~~

### 10.3 本机安全边界

必须机械拒绝：

- allowedRoots 为空时的任何 edit/write；
- 项目根目录本身的覆盖；
- .git、CrewForge 源码、testAgent 自身；
- 任意路径穿越；
- 未经用户确认的删除、覆盖、数据库破坏、系统级安装；
- 服务器下发的任意 shell。

bash 写盘命令只能做 best-effort 检查；edit/write 必须做强制路径检查。所有操作显示 diff，默认不自动提交 Git。

### 10.4 桌面端形态

建议采用 Vue UI + Tauri 2 壳 + testAgent sidecar：

- Vue 页面：项目打开、环境检查、错误证据、diff、执行日志；
- Tauri 权限：只允许用户选择的 workspace；
- sidecar：testAgent 可打包为 Bun/Node 可执行文件；
- 本机命令：由 sidecar 在受限目录执行；
- 远程服务：只传需求、Profile、RepairRequest 和用户明确选择上传的 Evidence；
- LLM API key：默认留在服务端或用户自己的配置，不写入生成项目。

如果 Tauri sidecar 在 Windows 发布阶段成本过高，可以先交付“本地 testAgent daemon + 浏览器控制台”，但核心 RepairRequest/allowedRoots 协议不能改变。

### 10.5 桌面端用户流程

~~~text
用户选择项目目录
  → 本机环境探测（Node/Bun/Java/Maven/Python/Docker）
  → 读取当前构建错误
  → 生成受限 RepairRequest
  → 用户查看将要修改的文件
  → testAgent edit/write
  → 重跑原命令
  → 保存本机 Evidence
  → 用户决定是否上传报告/提交补丁
~~~

桌面端可以帮用户把项目修到“在本机可运行”，但远程项目最终是否交付仍要满足对应环境的证据要求。两者分别标记为 local_verified 和 server_verified，不能混写。

---

## 11. 产品后端、前端和接口

### 11.1 产品后端职责

backed-CrewForge 负责：

- 登录、用户、权限；
- 项目 CRUD；
- 需求快照和 pipelineVersion；
- 启动、暂停、恢复 run；
- 查询运行摘要、slice、Evidence、失败账本；
- SSE/WebSocket 事件；
- StackProfile 列表和能力说明；
- 桌面端配对/授权；
- 报告下载和审计。

它不负责在 Controller 里执行 LLM 编排，也不直接更新 engine2 Ledger。

### 11.2 推荐 API

~~~text
POST   /api/projects
GET    /api/projects/{id}
PATCH  /api/projects/{id}
POST   /api/projects/{id}/requirements/snapshots
POST   /api/projects/{id}/runs
GET    /api/projects/{id}/runs
GET    /api/projects/{id}/runs/{runId}
GET    /api/projects/{id}/runs/{runId}/events
POST   /api/projects/{id}/runs/{runId}/resume
POST   /api/projects/{id}/runs/{runId}/questions/{questionId}
GET    /api/projects/{id}/runs/{runId}/evidence
GET    /api/projects/{id}/runs/{runId}/artifacts
GET    /api/stacks
GET    /api/stacks/{id}/{version}
POST   /api/desktop/sessions
POST   /api/desktop/repair-sessions
~~~

所有项目 API 必须检查 project ownership；runId 不能跨项目访问。

### 11.3 前端控制台

fronted-CrewForge 只展示后端事实：

- 项目列表和 pipelineVersion；
- 运行状态时间线；
- 当前步骤和 slice；
- 每一步的命令、exitCode、日志；
- HTTP 逐条期望/实际；
- DOM/截图；
- token、耗时、重试和预算；
- paused 问题和用户答复；
- 本地修复会话状态。

前端不根据“进度百分比”自行推断完成，不把 loading/网络成功当作 verified。

---

## 12. 数据库和存储布局

### 12.1 产品 MySQL

在现有 sys_project、sys_task、sys_project_file、sys_project_run、sys_settings 基础上增量扩展，避免一次性重复建两套系统。建议新增/补充字段：

- project.pipeline_version；
- project.requirement_hash；
- project.stack_profile_id/version/digest；
- run.engine_type、ledger_path、status、verified；
- task.slice_id、attempt_count、failure_signature；
- file.content_hash、owner、engine_owned；
- report.evidence_path、evidence_hash。

模板索引可以增加：

- cf_stack_profile；
- cf_stack_template_file；
- cf_stack_validation；
- cf_stack_capability。

### 12.2 每次 run 的文件布局

~~~text
runs/{runId}/
├─ requirement/
│  ├─ input.md
│  └─ snapshot.json
├─ _engine2/
│  ├─ spec.json
│  ├─ assumptions.json
│  ├─ plan.json
│  ├─ contract.json
│  ├─ route-manifest.json
│  ├─ http-cases.json
│  ├─ ledger.db
│  ├─ evidence.json
│  ├─ completion.json
│  ├─ run-report.md
│  └─ logs/
├─ backend/
├─ frontend/
└─ _shots/
~~~

_engine2、_verify、_shots 中的证据和引擎件不是业务任务的可写目录。

---

## 13. 测试分层和成本控制

### 13.1 零 LLM 常规测试

每次代码提交都跑：

- TypeScript 类型检查；
- Ledger 状态、租约、崩溃恢复；
- Fake LLM 十种异常；
- assumptions/openQuestions 分类；
- Contract IR 完整性；
- Domain IR 与 schema/query 一致性；
- ownership/路径/重复 owner；
- 前端重复 export、坏 import、Vue SFC；
- StackProfile 骨架真实 build；
- Verify 九步顺序和 Evidence 完整性；
- done 防伪；
- testAgent allowedRoots 和异常返回；
- 产品 API 编译和 HTTP 级测试。

这些测试不需要真实 LLM，也不应依赖网络。

### 13.2 发布候选真实 smoke

使用原始冻结 input.md，不在脚本里拼接人工补充文本。最多七次 LLM 调用：

1. 正常生成：analyze、plan、contract、backend implement、frontend implement；
2. 编译错误修复：复用相同 Spec、Plan、Contract，只调用一次 repair；
3. HTTP 错误修复：复用前述上下文，只调用一次 repair。

顺序：

~~~text
原始输入
  → 正常生成
  → 全量真实验证
  → 注入一个确定性编译错误
  → 一次 repair + 受影响验证
  → 注入一个确定性 HTTP 错误
  → 一次 repair + 受影响验证
~~~

任一类失败立即停止后续调用。记录：

- 每次请求、失败、超时；
- prompt/completion token；
- cost；
- 修改文件；
- 验证结果；
- 原文日志。

如果第一类正常生成失败，不得为了“凑满三类”继续烧钱。

### 13.3 成本预算

预算至少分为：

- run 总 token/美元；
- analyze/plan/contract/implement/repair 分项；
- 每 slice 尝试次数；
- 每次命令耗时；
- 网络安装耗时；
- 本地修复耗时。

默认策略：

- PR：Fake + 本地真实骨架 build；
- nightly：宿主/Docker 真实验证，仍不调用 LLM；
- release candidate：一次真实三类 smoke；
- 生产：按用户项目调用，命中输入/契约缓存不重复请求。

---

## 14. 失败处理和当前两类缺陷的修复顺序

### 14.1 失败分类

| 类别 | 例子 | 处理 |
|---|---|---|
| SPEC | 需求矛盾、阻塞问题 | paused，问人 |
| CONTRACT | 缺端点、契约 IR 非法 | 不落业务产物，停 |
| COMPILE | TypeScript/Java/Vue 编译失败 | 只修对应 slice |
| TEST/HTTP | 状态码/字段/业务流程错误 | 只修受影响 slice |
| ENV | Docker、JDK、MySQL、浏览器缺失 | 不调用 LLM，blocked |
| BUDGET | token/时间/尝试超限 | 停止并转人工 |

### 14.2 本次失败的最小修复顺序

第一步，不修改 runs/llm-s1-gen 中的结果来制造绿灯。它是证据样本，必须保留。

第二步，零 LLM 增加回归测试：

1. 给前端 API 文件注入重复 export，确认写盘/静态闸拒绝；
2. canonical table=note 时，schema/query 使用 notes，确认 Domain gate 拒绝；
3. HTTP 500 时报告包含应用 stderr 和 SQL 根因；
4. realLlm 失败请求计数仍增加；
5. openQuestions 中 implementation 细节进入 assumptions，关键问题才暂停。

第三步，修平台：

1. Contract/Domain IR 统一表名和字段；
2. Skeleton/业务 prompt 注入 canonical Domain IR；
3. Workspace 采用原子 replace 和唯一 owner；
4. 实现后执行静态 compile gate；
5. 验证器在同一临时库中执行迁移并把数据库对象快照写入 Evidence；
6. 修复调用计账和失败 signature；
7. 重新跑全部零 LLM 测试。

第四步，只重跑真实 smoke 的第一类。第一类通过后，才运行编译 repair 和 HTTP repair 两类。

第五步，三类证据齐全前，阶段 2 保持“代码层完成、真实模型质量未验证”，不得切第二栈。

---

## 15. 施工阶段和闸门

### M0：事实基线（已完成）

- 旧系统 s1/s2/s3 基线；
- before.json/before.md；
- 环境和历史日志；
- 旧系统不改写。

### M1：engine2 确定性地基（基本完成）

- Orchestrator、Ledger、Workspace；
- Fake LLM；
- Contract/Verify；
- 骨架真 build；
- done 防伪；
- testAgent 路径闸。

入口条件：tsc、全量 engine2 tests、骨架前后端 build 全绿。

### M2：真实模型前的平台修正（当前）

必须完成：

- assumptions/openQuestions 分类；
- Domain IR 和 canonical table gate；
- 重复 export/原子写盘 gate；
- 后端 API HTTP 级自动化测试；
- 迁移 SQL 在演示库执行；
- 失败日志和调用计数完整；
- 真实 smoke 脚本只读原始冻结输入。

闸门：零 LLM 测试全绿，且有一组针对本次失败的回归测试。

### M3：三类真实 LLM smoke

- 正常生成；
- 编译错误修复；
- HTTP 错误修复；
- 每类 Evidence 完整；
- 任一失败立即停止；
- 成本和耗时可复核。

闸门：三类都 pass，且 done=true、verified=true 的证据不是人工改写。

### M4：模板注册中心

- Profile manifest；
- 模板版本和 digest；
- capability 选择；
- 模板描述/注释；
- 迁移和骨架验证；
- StackProfile 管理 API。

闸门：Spring/Vue/MySQL Profile 可从注册中心加载并复现 s1。

### M5：第二条技术栈

建议先 Node.js + TypeScript，再 FastAPI。每次只做一个 Profile：

- 先支持同一 CRUD 冻结场景；
- 不复制旧系统正则；
- 复用 Contract IR、Domain IR、Evidence、Ledger；
- 增加该栈自己的 build/boot/migration/HTTP/render verifier。

闸门：新栈最小场景真实通过，失败分类正确，成本可接受。

### M6：testAgent 本地修复闭环

- RepairRequest/RepairResult；
- allowedRoots；
- diff 预览；
- 本机环境检查；
- 原命令重跑；
- local_verified 与 server_verified 分离。

闸门：testAgent 只能改用户选定目录，越界和异常都有可审计结果。

### M7：桌面端

- Tauri 2 壳；
- sidecar 生命周期；
- 本地日志；
- 用户授权；
- 项目打开/修复/导出；
- 断网时本地能力；
- 远程同步可选。

闸门：新用户在一台干净 Windows 机器上能打开项目、看到真实错误、批准一次修复并得到本机可运行证据。

### M8：旧系统切流和删除

只有 M3、M4、M5、M6 通过后才：

- 新项目默认 engine2；
- legacy 项目仍走 legacy；
- 观察期保留双跑对照；
- 删除旧控制流前导出历史数据；
- 删除 Hub/Graph/文本契约前确认无入口引用。

---

## 16. 目标代码布局

~~~text
agents-CrewForge/
├─ engine2/
│  ├─ entry.ts
│  ├─ orchestrator.ts
│  ├─ ledger.ts
│  ├─ workspace.ts
│  ├─ types.ts
│  ├─ realLlm.ts
│  ├─ fakeLlm.ts
│  ├─ contract.ts
│  ├─ verify.ts
│  ├─ projectAdapter.ts
│  ├─ steps/
│  │  ├─ analyze.ts
│  │  ├─ plan.ts
│  │  ├─ contract.ts
│  │  ├─ implement.ts
│  │  └─ repair.ts
│  └─ tests/
├─ engine/
│  ├─ stacks/
│  │  ├─ registry.ts
│  │  ├─ profile.ts
│  │  └─ profiles/
│  │     └─ spring-vue-mysql/1.0.0/
│  ├─ ir/
│  │  ├─ scenarioSpec.ts
│  │  ├─ domain.ts
│  │  ├─ contract.ts
│  │  └─ acceptance.ts
│  ├─ exec/
│  │  ├─ classify.ts
│  │  └─ verify/
│  └─ workspace/
│     ├─ ownership.ts
│     └─ skeleton/
├─ eval/
│  ├─ scenarios/
│  ├─ baseline/
│  └─ harness/
└─ legacy/
   └─ 旧消息团队（过渡期只读/兼容）

backed-CrewForge/
├─ server/src/main/java/.../
│  ├─ controller/
│  ├─ service/
│  ├─ mapper/
│  └─ ...
└─ sql/

fronted-CrewForge/
├─ src/api/
├─ src/views/
├─ src/components/
└─ src/stores/

testAgent/
├─ src/context.ts
├─ src/main.ts
├─ src/repair.ts
└─ tests/
~~~

文件名可以随实现调整，但边界不能调整：引擎、产品 API、控制台、本地修复器和生成项目不能互相越权。

---

## 17. 运行、部署和安全

### 17.1 服务器部署

生产部署至少包含：

- product API；
- engine worker；
- MySQL；
- Redis；
- web 反代；
- 可选 Docker 验证 worker。

Dockerfile/compose 必须在目标服务器实际 build/up/healthcheck 一次后才标“已验证”。Docker 不可用时可以用宿主验证，但报告必须显式标注 host。

### 17.2 进程和资源隔离

- 每个 run 独立 workspace；
- 每个验证服务独立端口和临时库；
- finally 清理应用、前端服务、临时数据库；
- CPU、内存、磁盘、网络和总时长有上限；
- 默认不挂载 docker.sock；
- 生成项目不能访问产品数据库凭据；
- 远程服务不能执行用户机器任意命令。

### 17.3 密钥和隐私

- LLM key、数据库密码只来自安全配置/环境变量；
- 生成项目的 application.yml 不写死真实密码；
- Evidence 上传前脱敏 token、cookie、Authorization、连接串；
- 用户代码默认不发送给第三方，上传范围由用户确认；
- 日志保留期限和删除接口要明确。

---

## 18. 当前执行令

在本蓝图成为团队共识后，下一条施工命令不是“再跑一次真实 LLM”，而是：

~~~text
任务 A：保留 runs/llm-s1-gen 失败证据，不修改它。
任务 B：为重复 export、note/notes 表漂移、openQuestions 分类、
        失败调用计数写零 LLM 回归测试，先确认测试能失败。
任务 C：实现 canonical Domain IR、原子写盘和静态闸，
        让这些测试变绿。
任务 D：补后端 API HTTP 测试，执行迁移 SQL 到临时演示库。
任务 E：全量零 LLM 测试通过后，只跑真实 smoke 类 1。
任务 F：类 1 通过后，再跑 compile repair 和 HTTP repair，各一次。
~~~

任何一个任务失败都要报告：

1. 失败的命令和 exitCode；
2. 原始 stdout/stderr；
3. 失败分类；
4. 是否消耗 LLM、消耗多少；
5. 改动的文件和哈希；
6. 下一步唯一建议。

不允许用“模型大概理解了”“这次应该可以”“编译过所以没问题”代替证据。

---

## 19. 最终判断标准

CrewForge 的含金量不来自 Agent 数量，而来自以下可复核能力：

- 需求和契约不会在角色转写中丢失；
- 技术栈选择受 Profile 和硬约束控制；
- 模板、数据模型、路由和迁移是一致的；
- 生成代码真的能构建、启动、打接口和渲染；
- 失败能分类、记账、恢复并有界修复；
- 真实模型失败时系统会诚实停下，而不是制造绿色状态；
- 用户可以在本机安全地把项目修到可运行；
- 每个结论都有命令、退出码和原文证据。

如果做不到这些，CrewForge 只是一个会调用 LLM 的代码生成脚本；如果做到这些，即使内部只有少数几个 Agent 边界，也是一条真正的软件交付流水线。
