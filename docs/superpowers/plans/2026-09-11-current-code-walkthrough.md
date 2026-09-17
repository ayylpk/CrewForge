# 当前代码说明（engine2 重构第一步，只读产出）

> 日期：2026-09-11　范围：`agents-CrewForge`（旧系统）+ `F:/code/agent/testAgent`（终检 agent）
> 纪律：**本文件是新增文档，除它之外没有改动任何文件**（代码一行未动）。
> 目的：动 `engine2/` 之前，先回答"现在谁在做什么、哪里能把失败写成成功"。

---

## 0. 阅读清单核对（16/16 齐备）

| # | 文件 | 行数 |
|---|---|---|
| 1 | `README.md` | 91 |
| 2 | `docs/superpowers/plans/2026-09-10-pipeline-rewrite-plan.md` | 604 |
| 3 | `agents-CrewForge/eval/baseline/phase0-report.md` | 169 |
| 4 | `agents-CrewForge/eval/scenarios/s1-crud-min/input.md` | 45 |
| 5 | `agents-CrewForge/eval/scenarios/s1-crud-min/expected.json` | 90 |
| 6 | `agents-CrewForge/projectRunner.ts` | 443 |
| 7 | `agents-CrewForge/foundation.ts` | 417 |
| 8 | `agents-CrewForge/task.ts` | 222 |
| 9 | `agents-CrewForge/engine/run/finalGate.ts` | 164 |
| 10 | `agents-CrewForge/engine/run/state.ts` | 171 |
| 11 | `agents-CrewForge/engine/run/store.ts` | 128 |
| 12 | `agents-CrewForge/engine/exec/verify/taskVerify.ts` | 184 |
| 13 | `agents-CrewForge/engine/exec/verify/runVerify.ts` | 286 |
| 14 | `F:/code/agent/testAgent/README.md` | 51 |
| 15 | `F:/code/agent/testAgent/src/main.ts` | 171 |
| 16 | `F:/code/agent/testAgent/src/context.ts` | 128 |

补充读取（为回答"哪里误写成功"）：`common.ts`、`fileTools.ts`、`testEngineer.ts`、`maintainer.ts`、`contracts.ts`(节选)、`engine/workspace/ownership.ts`(节选)、`engine/run/completion.ts`(节选)，以及若干 grep 证据。

---

## 1. 链路总览（旧系统，消息团队版）

```
DB(sys_project.description)  ──►  Manager(LLM 多轮对话)  ──►  plan.phases[]  ──► DB(dev_plan)
                                        │
                    projectRunner.drivePhases（阶段消息往返，Hub）
                                        ▼
   Architect(LLM) ──► ExecTask[]（前后端，含 files/method/path）──► DB(sys_task, ensureTasksForPhase)
        │                        │
        │                        ├─► 落盘 _verify/acceptance-p{N}.json（交付关输入）
        │                        └─► contracts.ts(LLM) ──► CONTRACTS.md（散文，可旁路）
        ▼  消息 task / pair_ready / revision / task_passed / phase_done
   Backend|FrontendEngineer(LLM + 工具循环) ──► 落盘（writeWorkspace）──► sys_project_file
        ▼
   Merger（配对缓存，零 LLM）──► TestEngineer（机械三查 + LLM 六项纸审）
        ▼
   Maintainer（零 LLM 集合收敛）──► Architect（phase_done → 下一阶段）
        ▼
   projectRunner 收尾：finalGate（执行式验证）──► completion.finalizeProject ──► decideProjectStatus ──► sys_project.status
```

**并存的"新的那一半"（已在 `engine/**`，零 Hub 依赖，共 47 个 ts / 非 smoke 4,435 行）**：
`run/{state,store,scheduler,finalGate,completion,crash-child}`、`exec/{run,classify,editAnchor,tools,static/*,verify/*}`、`ir/{acceptance,contract,scenarioSpec,predicates,ir-smoke}`、`workspace/{ownership,skeleton/springVueMysql}`、`stacks/profile`、`steps/{promptPrefix,contextBudget,codeQualityRules}`。
**已核实**：`engine/**` 内 **没有** 任何 `Hub` / `BaseAgent` / `GraphFactory` / `merger` / `maintainer` 的 import（grep 为空）——与提示词第四条禁令一致，engine2 可以是纯新增目录。

---

## 2. 谁负责生成需求

| 环节 | 位置 | 事实 |
|---|---|---|
| 需求原文 | `sys_project.description` / `clarified_req` | **不由 LLM 生成**，来自前端写入的 DB 字段（`projectRunner.ts:234 getProjectRequirement`） |
| 需求澄清 | `manager.ts`（PM 多轮对话） | `HumanMessage` 开场注入需求原文（`projectRunner.ts:236`），轮次上限 30（`:246`） |
| 计划（phases） | `manager.ts:432` `retryStructured` → `planItem[]` | `saveDevPlan` 落 `dev_plan`（`manager.ts:27`）；`projectRunner.ts:227 usablePhases` 做形状校验，脏 plan 丢弃 |
| UI 决策 | `manager.ts:372-374` | UI 三问缺失时兜底 `uiProfile.defaulted=true`（**标注为兜底**，进契约） |
| 跳过对话 | `projectRunner.ts:282` | 库中已有合法 `dev_plan` → 直接开工（断点续跑） |

**失败模式（实测）**：s2-auth 里 `architectPlan` 结构化输出连续 3 次解析失败 → 未捕获异常 → **进程 exit=1**、项目停在 `planning`、0 任务 0 产物（phase0-report §3）。

---

## 3. 谁负责生成任务

| 环节 | 位置 | 事实 |
|---|---|---|
| 拆分 | `architect.ts`（LLM） | `makeDispatchNode`（`:616`）产出 `ExecTask[]`（`common.ts:21`：id/layer/method/path/files/acceptance/phase/stack） |
| 落库 | `architect.ts:911 bridgeTasks` → `task.ts:156 ensureTasksForPhase` | 幂等键 `(project_id, phase_id, task_id_ext)`；`sort_order = phase*1000+i` |
| 声明 | `architect.ts:705` `tasks_declared{phase,pairIds,final:true}` | 维护者据此收敛 |
| 契约散文 | `contracts.ts`（LLM） | 生成 `CONTRACTS.md`；**失败即旁路**（`:157-159 return null`） |
| 验收 IR | `architect.ts:689` | 写 `_verify/acceptance-p{N}.json`；来源优先级：冻结场景规格 → 任务字段 + 需求里解析出的成功码（`:668-676`） |
| 0 任务分支 | `architect.ts:914-916` | 方案被拒/拆分失败 → **声明 0 对并 final**"阶段完成" |

---

## 4. 谁负责写文件

| 通道 | 位置 | 校验强度 |
|---|---|---|
| 唯一落盘口 | `common.ts:98 writeWorkspace` | **只做沙箱逃逸检查**（`safeRealPath`）；不校验引擎件、不校验白名单 |
| 工具循环（默认关，`sys_settings.tool_mode`） | `fileTools.ts` `executeFileTool:165` | `path !== targetFile` → 拒（`:250`/`:267`）；内容过 `checkFile` 编译闸（`:159`）；文件级锁 `withPathLock:126` |
| 引擎件判定 | `engine/workspace/ownership.ts decideWrite` | 四条规则（逃逸 / 引擎拥有件 / 出计划 / 他人占用），只被 `backendEngineer.ts:38`、`frontendEngineer.ts:40` 使用 |
| 引擎直出 | `foundation.ts:187 enforceEngineFoundation`、`:285 registerRoutes`（含主页面机械挂 `/`，`:313`） | 代码强制，DB 旧 prompt 顶不掉 |
| 骨架 | `engine/workspace/skeleton/springVueMysql.ts`（`SKELETON_PATHS`） | 13 件引擎拥有件的事实来源（`foundation.engineOwnedFiles`） |
| 产物登记 | `writeWorkspace` 内 `Node.upsertProjectFile`（fire-and-forget） | 失败只 `console.warn`（`common.ts:106`）→ 磁盘与 DB 可能不一致 |

> **对 engine2 的直接含义**：提示词要求的 `WRITE_REJECTED reason=ENGINE_OWNED_FILE path=...` 这种错误格式**当前不存在**（全仓库 grep `WRITE_REJECTED` / `ENGINE_OWNED_FILE` 命中 0 处）。现在只有 `ownership.ts` 的结构化 `{code:"engine_owned"}`，且**未接进默认写盘路径**（默认关的工具模式才走）。

---

## 5. 谁负责测试（判决权分层）

| 层 | 位置 | 判据 |
|---|---|---|
| L1 静态闸（写盘前） | `checkers.ts checkFile` | 编译级 reject；**`.java` 无派发**（缺口，见 §6-⑨） |
| L2 任务级执行验证 | `engine/exec/verify/taskVerify.ts` | 后端 `mvn compile`（离网先行，ENV 再联网一次）、前端 `npm run build`；结果含 `signature` |
| L3 run 级执行验证 | `engine/exec/verify/runVerify.ts` | 起库（docker / **宿主 MySQL**）→ 起应用 → 健康检查 → 契约测试 → **finally 必清理**；`dbMode=host` 时报告写"宿主验证" |
| L4 交付关 | `engine/run/finalGate.ts` | 三态 `done / failed / skipped_unverified`，`verified` 独立布尔（`:88-98`）；异常一律 `failed`（`projectRunner.ts:400-403`） |
| L5 终态判据 | `engine/run/state.ts:107 decideProjectStatus` + `engine/run/completion.ts:65 finalizeProject` | 唯一出口：0 任务/0 产物 → failed；有 failed 任务 → failed；`skipped_unverified` → blocked；只有 `done + verified + 断言全过` 才 done |
| 测试工位（LLM + 机械） | `testEngineer.ts` | 机械三查：编译复核 / 硬编码色 `scanHardcodedHex` / 渲染审（真开 headless）；LLM 六项清单；`enforceChecklistConsistency:134` 机器改判（`checks` 有 fail 而 pass=true → 改判） |
| 账本/恢复 | `engine/run/store.ts`（bun:sqlite WAL）、`state.ts`（`hashInput` / `leaseUntil` / `isReclaimable`） | step 幂等 + 租约回收（**当前尚未接进 runner 主路径**，是独立能力） |

---

## 6. 当前哪里可以把失败错误地写成成功（按危险度排序）

| # | 位置 | 为什么是"假成功"的入口 | 现在有没有被兜住 |
|---|---|---|---|
| ① | `architect.ts:914-916` | 拆分失败 → 声明 **0 对** + `final:true` → `maintainer.ts:78-81` 判"阶段完成" → 阶段语义上是"完成"，实际零产出 | 项目级被 `decideProjectStatus` 兜住（0 任务/0 产物 → failed）；**阶段级语义仍不设防** |
| ② | `maintainer.ts:80-81` | 收敛条件写作 `if (declaredPairs.size > 0 && !every(...)) return;` —— 空集合**直接算收敛**（"没有任务"= "全做完"） | 同上（项目级兜住，阶段级不设防） |
| ③ | `task.ts:95-100 updateTaskResult` | 无条件 `SET status='done'`——任何调用方写一次 result 就是 done，**不校验任何证据** | 无 |
| ④ | `contracts.ts:157-159` | 契约生成失败 `return null` → 下游全体"按无契约跑"（静默旁路），`pairIntegrationCheck` 也失去基准 | 无（这是设计版 §1.4 点名要删的机制） |
| ⑤ | `foundation.ts:396-417 expectedApisOf` + `pairIntegrationCheck` | 用正则从 `task.description` 的文本行取"期望接口"——换个写法即漏检，**漏检即放行**，还会被当成"前后端对齐"证据 | 无（设计版要求把它的判决权降为诊断附注） |
| ⑥ | `checkers.ts:436-454`（DISPATCH） | **`.java` 没有派发**：主栈占比最高的文件类型写盘时零校验（F-2/F-3 实锤） | 已被 `taskVerify`（真 `mvn compile`）在下游兜住一部分，但写盘前无闸 |
| ⑦ | `fileTools.ts:159 gateContent` → `checkers.checkFile` | 闸门是"编译级"；**语义错误、接口 404、字段错位一概放行**，而 `write` 的返回文案对模型是"已落盘（编译校验通过）" | 设计上交给下游 testEngineer/verify——但如果下游渲染审 `skip`（Edge 起不来），这条链就断了 |
| ⑧ | `testEngineer.ts:134 enforceChecklistConsistency` | 只拦"`checks` 里有 fail 却 pass=true"；**六项全 `skip` + pass=true 不算矛盾**（六项缺位机器补记 skip，不否决） | 无（"缺证据的通过"未被拦） |
| ⑨ | `testEngineer.ts:298-302` | LLM 判定调用失败按 `both` 打回（方向正确）——但反过来看，判定能力完全依赖 LLM 调用成功 | 无 |
| ⑩ | `common.ts:104-107` | `sys_project_file` 落库失败只 `warn`：磁盘有、DB 无 → 证据链在库侧断裂而不拦路 | 无 |
| ⑪ | `models.ts resolveRoleTier` | 配置损坏 → `catch {}` **静默回落内置档位**（不告警）；同类"静默降级"是设计版点名的病根 | 无（设计版要求"旁路必须告警"） |
| ⑫ | `task.ts:185-205 updateStatusByExt` | 桥定位为"可观测层不是控制层"，异常只 `warn` → 任务可永久停在 `doing`，看板不反映失败 | 属于刻意设计，但对外表现为"状态不收敛" |
| ⑬ | `projectRunner.ts:400-403`、`:314-329` | 曾是"交付关异常返回 done"、"skipped_unverified 仍写 done"——**这两条已修**（异常→failed；skipped→blocked） | 已堵（保留记录以便回归） |

**一句话**：项目级 `done` 现在守得住（`decideProjectStatus` 六条件 + `verified` 独立字段）；**守不住的是"阶段级完成"（① ②）、"任务级 done"（③）、以及"证据缺失时的通过"（⑦ ⑧）**——这正是 engine2 第 14 步"统一完成条件"要覆盖的区段。

---

## 7. 当前哪些地方依赖 Hub

`Hub.ts` 提供 `TransferStation`（`:67`）、`roles`、`WorkQueue`（进程内消息总线，无持久化）。

| 依赖方 | 位置 | 依赖内容 |
|---|---|---|
| `BaseAgent.ts` | `:20` | 基类构造注册 + 订阅（全部 agent 的父类） |
| `projectRunner.ts` | `:23,164,168,199,210,300` | 建站、`drivePhases` 阶段消息往返、必需角色 fail-fast（`:209-221`） |
| `architect.ts` | `:21,616,698,815-824,938,997,1014` | 站、按角色选最少忙实例、订阅 `task_rejected` |
| `backendEngineer.ts` / `frontendEngineer.ts` | `:18`/`:19` | `roles`、`WorkQueue`（双队列） |
| `merger.ts` | `:14,33-34,86-117` | 配对缓存 + 按角色派发 |
| `maintainer.ts` | `:11,24` | 集合收敛（`task_passed` / `task_failed` / `tasks_declared`） |
| `testEngineer.ts` | `:21,193` | 订阅 `pair_ready`、`send` 返工/上报 |
| `core-team-smoke.ts` | `:1` | 团队构成断言 |

**控制流进 DB 的部分（同属"要拆"的一类）**：`Node.ts`（节点/边/prompt 覆盖，`nodePrompt`）、`GraphFactory.ts`（`Questioner` + 图编译）、三张表 `sys_agent_node` / `sys_project_agent_node` / `sys_agent_edge`；消息 schema 在 `messageProtocol.ts`（`PhaseRequestMessageSchema`）。

---

## 8. 当前哪些地方调用 LLM

| 边界 | 文件 | 调用点（grep `SystemMessage` / `retryStructured`） |
|---|---|---|
| PM 需求澄清 / 规划 | `manager.ts` | 6 处（pm 对话、planner 计划、UI 三问兜底） |
| 架构师：阶段规划 / 拆分 / bootstrap / 栈 | `architect.ts` | 4 处 |
| 工位：伪代码 + 设计稿 + 代码实现 | `backendEngineer.ts` / `frontendEngineer.ts` | 各 3 处（含工具循环 system） |
| 测试判定 | `testEngineer.ts` | 2 处（六项纸审） |
| 契约散文 | `contracts.ts` | 2 处 |
| 工具循环协议 | `fileTools.ts` | 2 处（system 拼装） |
| 图节点内调用 | `GraphFactory.ts` | 2 处 |
| 统一闸 | `llm.ts` | `retryStructured`（反馈式重试 + `StructuredOutputFailure`）、`invokeWithTimeout` |
| 模型构造 / 档位 | `models.ts` | `initModels`（档位表 + 静默回落） |
| 终检 agent（独立仓库） | `testAgent/src/main.ts:114` | `agent.invoke(messages)`，`maxIter` 默认 999 / `--auto` 30 |

合计 **15+ 个调用点**，收敛目标 7 个（`analyze / plan / contract / skeleton / implement / repair / report`）。

**testAgent 现状（与提示词第十二步的差距）**：`src/main.ts` 是五工具循环（bash/read/grep/edit/write，`tool.ts`），输出契约是 `--json {verdict: pass|fail|incomplete|error, testsPassed, summary, remainingIssues}`（`README`）；`src/context.ts` 做项目检出（package.json → pom.xml → build.gradle）。**当前没有** `allowedRoots` 概念、没有 `RepairRequest/RepairResult` 类型、没有"只改 allowedRoots / 不改 CrewForge 源码与自身"的机械限制——这三条是第十二步要新增的。

---

## 9. 对照提示词：已有 / 缺什么（engine2 施工前提）

**可直接复用（不重写）**：`run/store.ts`（Ledger）、`run/state.ts`（状态迁移 + 终态判据）、`exec/verify/{runVerify,taskVerify,maven,docker,hostDb,tools}`、`ir/{acceptance,contract,scenarioSpec}`、`workspace/{ownership,skeleton/springVueMysql}`、`exec/{classify,static/*,editAnchor}`、`steps/{promptPrefix,contextBudget,codeQualityRules}`、`runEnv`（沙箱）。

**engine2 需要新增（当前缺口）**：
1. `engine2/` 12 个文件本身（目录不存在，零冲突）；
2. **Fake LLM 十种模式**（现无——一切确定性测试都缺这个替身）；
3. `WRITE_REJECTED reason=ENGINE_OWNED_FILE path=...` **错误格式**（现无，只有 `{code:"engine_owned"}`）；
4. **结构化 Contract 的 5 端点 IR + 渲染物**（`contract.json` / `route-manifest.json` / 前端 API 文件 / 后端清单 / HTTP 用例）——现在 s1 的六条 HTTP 断言在**评测 harness** 里（`eval/scenarios/s1-crud-min/expected.json`），引擎侧只有 `acceptance-p{N}.json`，没有 route-manifest 渲染器；
5. **统一 done 的十条件入参**：`decideProjectStatus` 目前只有 6 个输入（taskCount / artifactCount / failedTaskCount / finalGateStatus / verified / requiredAssertionsPassed），提示词要求的"前端 build exit=0、后端 build exit=0、启动成功、库初始化成功、HTTP 全过、渲染通过、Evidence 新鲜"需要**逐项成为显式字段**而不是折叠成 `verified`；
6. **重试规则的类型化**：现状计数是内存 `Map`（`testEngineer.testjudgements`、`merger` 配对缓存），跨进程即失忆；提示词要求的 `{taskId, attempt, failureCategory, failureSignature, inputHash, evidenceHash, changedFiles}` 账本当前**没有对应落盘结构**（`run/state.ts` 的 step 表具备字段基础，但未接主路径）；
7. **Repairer 的失败证据入参**（`failureCategory` 六类已有 `classify.ts`，但 `repair` 作为独立 LLM 步骤尚不存在——现状是测试判负发 `revision` 消息）；
8. **testAgent 的 `allowedRoots` + `RepairRequest/RepairResult` 契约**。

---

## 10. 本次阅读得出的三条判断（供你确认下一步）

1. **写盘闸门存在"两套清单、一个执行者"的不一致**：`ownership.decideWrite`（引擎件清单）只在工具模式的工位被调用，而默认写盘路径 `writeWorkspace` 完全不查引擎件——所以"越界必须被拒"这条不变量，**目前只在部分路径成立**。engine2 的 `workspace.ts` 必须把这条做成**唯一入口**（所有写盘都过它）。
2. **"0 产物也是完成"这条病没有被根治，只是被下游拦住了**：阶段级（① ②）与任务级（③）仍能写出"完成"，项目级只是在最后一步用 `decideProjectStatus` 兜底。engine2 按提示词第十四步把 done 条件做成**唯一函数 + 显式字段**，属于把兜底前移，方向正确。
3. **"证据缺失时的通过"是最隐蔽的一类**（⑦ ⑧ ⑩ ⑪）：编译闸只 reject、渲染审可 `skip`、清单可全 `skip` 而 pass、DB 落库失败只 warn——四处都不会让流程失败，但都会让结论失去证据支撑。engine2 的 verify.ts 要求"9 步顺序执行 + Evidence 齐全"，正好覆盖这一区段。

---

## 11. 声明

- 本文件为**新增文档**；`agents-CrewForge/**`、`fronted-CrewForge/**`、`backed-CrewForge/**`、`F:/code/agent/testAgent/**` 的代码**一行未改**。
- 冻结件（`eval/scenarios/*/input.md`、`expected.json`、`eval/baseline/before.json`、阶段 0 报告）**未触碰**。
- 未运行任何真实 LLM 调用；本说明全部来自读文件与只读 grep。
- 未完成 `engine2/` 的任何代码——按纪律，等本说明确认后再开工。
