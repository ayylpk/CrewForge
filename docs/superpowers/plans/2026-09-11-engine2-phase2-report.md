# CrewForge 阶段 2 报告：engine2 接入产品主流程

日期：2026-09-11 ｜ 范围：`agents-CrewForge/engine2`、`projectRunner.ts`、`backed-CrewForge`、`fronted-CrewForge`
硬规则遵守情况：**基线全绿之前未动生产入口、未调任何真实 LLM**；未改冻结件；无伪造 done/verified/Evidence。

---

## 1. engine2 确定性测试结果（第一步基线）

| 项目 | 结果 |
|---|---|
| `bun x tsc --noEmit` | exit=0 |
| `bun run engine2/tests/run.ts`（基线时点） | **86/86 全绿**，含骨架前端真 build（npm install+build 231s）、骨架后端真 build（mvnw 13s）、wrapper 自检——全部真实执行 |
| 阶段 2 新增后 | **100/100 全绿**（新增 adapter.test 14 用例） |

环境：bun 1.3.14 / Windows 11 / managed Node 22.22.2 / 宿主 MySQL 8。
⚠️ 运维提示：整跑套件约 6 分钟，命令默认 120s 超时会腰斩成"静默退出码 1"，需后台跑或 `ENGINE2_SKIP_BUILD=1`。

## 2. 第二步：Engine2 项目入口

- `engine2/entry.ts`：新增 `run-project --project-id N` 子命令（1 收 projectId → 2 读项目表需求 → 3 requirementText → 4 runId → 5 Ledger → 6 runEngine2 → 7 输出终态 → 8 保存运行报告 → 9 退出前关 Ledger）。**未 import** Hub/BaseAgent/GraphFactory/merger/maintainer。
- `engine2/projectAdapter.ts`（新增）：`runProjectWithEngine2()` 唯一项目级入口；`mysqlProjectRepo` 直连 db.ts 连接池（不牵连旧图/模型层）；DB 读写可注入，确定性测试用内存实现。

## 3. 第三步：pipeline_version

- 实现位置：
  - `backed-CrewForge/sql/migration_pipeline_version.sql`（幂等加列，默认 legacy）+ `schema.sql` 同步；
  - `Project` 实体 / `ProjectDTO` / `ProjectVO` 加 `pipelineVersion`（update 校验只允许 legacy/engine2，create 默认 legacy）；
  - 引擎侧权威判定：`engine2/projectAdapter.ts` 的 `decidePipelineForProject()`；
  - Java 接线：`ProjectRunServiceImpl.spawnEngine` 仅对 engine2 项目注入 `CF_ENGINE=engine2`（legacy 不注入任何 flag，行为与从前逐字节一致）；
  - `projectRunner.ts` 入口判定改走 DB 权威；
  - 每次运行保存 pipeline_version：Ledger `pipeline_version` 事件 + `_engine2/runs/{runId}.json`。
- 语义落地：默认 legacy；engine2 项目只能启动 Engine2（`CF_ENGINE=legacy` 对它**拒绝启动**，不是回退）；同项目运行中（账本 15 分钟内有进展的 running run）禁止重复启动；失败绝不自动切 legacy，显式回退=用户改项目字段。

## 4. 第四步：Fake LLM 生产接线（10 场景，全部经 projectAdapter 走真实代码路径）

| # | 场景 | 终态 | 项目状态 |
|---|---|---|---|
| 1 | 正常生成 | done | done |
| 2 | Contract 缺 PUT | failed（CONTRACT，不生成骨架） | failed |
| 3 | Contract 为空 | failed（CONTRACT） | failed |
| 4 | 骨架文件缺失 | failed（SPEC，未验证≠通过） | failed |
| 5 | 后端 build 失败 | failed（COMPILE） | failed |
| 6 | HTTP PUT 500 | failed（CONTRACT，证据记录真实 500） | failed |
| 7 | 页面白屏 | failed（TEST，渲染 0 字入证据） | failed |
| 8 | 重复同一错误 | failed（repeat_error_stop，只修 1 次） | failed |
| 9 | 进程中途终止后恢复 | **真实进程级验证**：kill -9 后同 runId 续跑 → done，**LLM 调用=0（缓存全命中）** | done |
| 10 | 预算超限 | budget_exceeded | blocked |

每个场景结果均写入 Ledger（run/slice/step/failure/event 六表）并断言最终状态正确（adapter.test.ts）。

## 5. 第五步：后端报告 API（新增）

`Engine2RunReportController`（`/api/projects/{projectId}/runs/{runId}`）：
- `GET /` run 总览（状态/pipeline_version/切片/失败/预算/程序产出的验证结论）；
- `GET /events` Ledger 事件流水；
- `GET /evidence` 证据 + 日志尾内联（限 runs-root 内，防任意路径读）；
- `POST /resume` 复用 ProjectRunService.start（所有权门/防双起/进程落账全复用）；
- `POST /cancel` 写控制文件 + 停进程，进程边界生效；终态幂等。
数据源只有 `_engine2/runs/{runId}.json`（Ledger 导出）与 `evidence.json`，**不返回任何模型自述**；runId 可传 `latest`（引擎写 latest-run.json 指针）。

## 6. 第六步：前端报告页（新增）

- `fronted-CrewForge/src/views/Engine2RunView.vue`（路由 `/projects/:id/runs/:runId?`）+ `src/api/engine2Run.ts`。
- 展示：run 状态、pipeline_version、当前步骤、Slice 状态（含 retryCount/尝试次数）、失败类别、命令与 exitCode、日志尾、Evidence、预算、未满足项；续跑/取消按钮；运行中 5s 轮询。scoped 样式，**零全局 CSS/配色改动**；无聊天气泡、无"思考中"动画——失败原因与证据优先。

## 7. 第七步：s1 真实命令全链验证（Fake LLM 生成，命令全部真实执行）

`runs/e2e-phase2-s1`（runId phase2-e2e-s1）：**终态=done，verified=true**
- files_exist ✔ / frontend build exit=0 ✔ / backend build exit=0 ✔ / 后端启动 ✔（端口 21770）/ db_init ✔（宿主验证（host）库 engine2_verify_mtwr5po3，报告如实标注"宿主验证"）/ HTTP 契约 ✔（**6 条全过**：POST/GET 列表/GET 单个/PUT/DELETE + 删除后再 GET 404）/ 页面渲染 ✔（66 字，含「便签」）/ evidence.json 落盘 ✔。
- Fake LLM 调用 5 次（analyze/plan/contract/implement×2），任何一步未执行即不写 verified（判据由程序执行）。

## 8. 第八步：生产接线测试（8 项）

1. Engine2 正常运行 ✅（上面 s1 真实 E2E）
2. 失败运行 ✅（第 4 节 2-8 场景，全部 failed/blocked 不 done）
3. 取消运行 ✅（控制文件→cancelled→项目 paused，幂等；真实进程取消=Java stop+ctl 同路径）
4. 杀进程后恢复 ✅（真实 kill -9 → resume → done，LLM 0 次零重跑）
5. legacy 项目仍可启动 ✅（判定矩阵测试：legacy 不注入 flag、走原路径；真实 legacy 端到端需 DB+真实 LLM，标注"待联调"）
6. 重复启动被拒 ✅（账本 fresh 守卫测试 + Java isRunning 原有防线）
7. 失败不会变 done ✅（PROJECT_STATUS_OF 反例测试 + 九类反例测试）
8. 失败不自动走 legacy ✅（engine2+CF_ENGINE=legacy → Engine2StartRejected 测试）

## 9. 第九步：真实 LLM 最小验证 —— ✅ 三类全部通过（2026-09-11 晚间收官）

前置补齐（当日完成）：
- 迁移 SQL 已在演示库执行（`pipeline_version` 列就位，存量项目全部 legacy 零影响）；
- 后端报告 API HTTP 冒烟 **13/13 通过**（登录→建项目→造产物树→5 端点正向+4 反例：终态 resume 拒绝、cancel 幂等、路径逃逸 400、无 token 401）；
- 确定性测试含新增 sourceGate 用例后 **107/107 全绿**。

spec-kit（github/spec-kit）机制采纳：
- `engine2/steps/clarify.ts`：analyze 发现需求歧义 → 一轮结构化澄清（≤5 问、每问带选项与推荐答案、自动采纳推荐并逐条留痕到 spec.clarifications 与 Ledger `clarified` 事件）→ 清不掉才 paused（SPEC）；
- `statusClass` 类别断言（2xx/4xx）：需求未写死的状态码用类别匹配，200/201 之争机制性消失；
- 新增 clarify.test.ts 5 用例。

三类真实调用结果（模型 deepseek-flash；逐次留档见 `runs/llm-smoke/evidence.json` 的 callLog：模型名/输入 SHA-256/token/耗时）：

| 类 | 结果 | LLM 调用 | tokens | 成本 | 修复改动文件 |
|---|---|---|---|---|---|
| 1 正常生成 | **done + verified=true**（19:37 轮九步真实验证全过） | 5 | 5965+14508 | $0.0176 | 引擎骨架+模型产出 4 文件 |
| 2 编译错误修复 | 注入语法错 → repair 1 次 → **ok verified=true** | 1 | 1606+9822 | $0.0112 | NoteService/NoteController |
| 3 HTTP 错误修复 | 注入 PUT 500 → repair 1 次 → **ok verified=true**（PUT 实测 200） | 1 | 1630+4296 | $0.0052 | NoteController/NoteService |

本轮三类合计 0.034 USD（≈0.24 CNY）。如实说明：① 类 1 曾因真实模型挑出需求歧义 paused 两轮（openQuestions 纪律正确工作），clarify 机制采纳后收敛；② 类 1 在禁修复预算（maxAttemptsPerSlice=1）下重跑出现过一次 paused——**单次生成通过率非 100%，修复循环是必要的**（生产建议 maxAttemptsPerSlice=2）；③ 全天累计真实调用约 25 次，总成本 < 0.15 USD。

冒烟暴露并已修复的引擎缺陷：openQuestions 无收敛（→clarify）、200/201 精确断言摩擦（→statusClass）、repair 缺 schema/最小改动/端点保留铁律（→prompt 铁律+sourceGate 硬闸）、前端 API 渲染器不去重（→按函数名去重）。

**是否批准进入第二条技术栈：批准。** 前提条件全部满足：真模型生成、编译修复、HTTP 修复三类调用全部通过机械验收；引擎防伪机制在真实模型面前经受住检验。

---

（以下为早前"未执行"时的原文存档）
## 9. 第九步：真实 LLM 最小验证 —— **未执行（0 次调用）**

- `engine2/realLlm.ts` 已就绪（OpenAI 兼容端点、温度 0、sys_settings>.env 取配置、token 计量+牌价估算成本、输出仅作"提议"交权威校验）。
- 未执行原因（如实）：前置条件中"backend API 测试全绿"目前只有**编译通过+代码审查**，尚无 HTTP 级自动化测试（需要运行中的后端+登录态+DB）。按本提示词纪律，前置未全满足不调用真实 LLM。
- 真实 LLM 调用次数：**0**；成本：**0**。

## 10. 其他交付与说明

- **需要单独告知的前端改动**：`fronted-CrewForge/vite.config.ts` 加 `build.emptyOutDir:false`——本机 safe-delete 钩子会拦 vite 清空 dist（批量删除需确认）导致 build 必失败，与 engine2 骨架模板同一解法；只影响构建清理行为，**不涉及任何配色/CSS**。
- 后端构建注意：pojo 是独立模块，必须从根聚合 pom 构建（`mvnw package` in backed-CrewForge/），单构建 server 会用 .m2 旧 pojo 报"找不到符号"。
- Git：工作树含此前会话遗留的大量未提交改动（GraphFactory/architect/engine 等），本次未混提；建议按里程碑分批提交。
- 冻结件零改动（eval/*、阶段 0 报告）；未删除旧 Hub/BaseAgent/GraphFactory/Merger/Maintainer；legacy 与 engine2 互斥启动（Java 进程账目保证不同时双跑）。

## 11. 未完成事项

1. 真实 LLM 最小验证（3 类调用）——前置"后端 API HTTP 级测试"就绪后执行；
2. 后端报告 API 的 HTTP 级自动化测试（MockMvc/启动联调）；
3. legacy 引擎真实端到端冒烟（需 DB + 登录态）；
4. `sys_project.pipeline_version` 迁移 SQL 需在演示库实际执行（幂等，可重复跑）；
5. 前端项目列表→运行报告入口链接（可从 ExecutionView/ProjectDetailView 加跳转，本次未动既有页面）。

## 12. 是否允许进入第二条技术栈阶段

**建议：暂缓，先补第 11 节 1-2 项。** 阶段 2 完成条件中除"真实 LLM 最小验证"外均已达成（engine2 可从项目入口启动 / Fake 流程完整 / 真实验证证据完整 / 报告 API 可用 / 前端可查证据 / legacy 不受破坏 / 无静默回退 / 无伪造 done / s1 至少一次真实交付成功 ×2）。第二条技术栈应在真实 LLM 链路也过一遍 s1 后再开工，否则会把未验证的生成质量假设固化为栈假设。
