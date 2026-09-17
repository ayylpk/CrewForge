# engine2 施工报告（按提示词 §十八 逐条回答）

> 日期：2026-09-11　范围：`agents-CrewForge/engine2/**`（新增）+ `F:/code/agent/testAgent/src/{context,main}.ts`（改造）
> 纪律：**未调用任何真实 LLM**；未修改任何冻结件；未向旧系统增加功能。

---

## 0. 一句话结论

新执行入口 `engine2` 已按提示词 §四~§十五 全部落地；**确定性测试 76/76 全绿（含骨架前端/后端真 build）**，`bun x tsc --noEmit` 退出码 0。
真实 LLM 的开启条件（§十七 七条）**已全部满足**，但**按你的明确指令没有执行任何真实 LLM 测试**。

---

## 1. 修改了哪些文件

### 新增：`agents-CrewForge/engine2/`（§四 要求的 12 个文件，一个不多）

| 文件 | 职责 |
|---|---|
| `types.ts` | §五 四个类型 + Spec/Plan/Slice/Contract/Evidence/WriteDecision/DoneInput；**权威字段禁令**（`findAuthorityFields` / `validateLlmOutput`） |
| `ledger.ts` | 六张表（run/slice/step/failure/budget/event）+ **状态迁移表**（slice/run 各一张）+ 租约 + 失败账本 + 预算 + `reclaimExpired` |
| `workspace.ts` | §七 十二条写盘权限 + `WRITE_REJECTED reason=<CODE> path=<path>` + §八 `spring-vue-mysql` 骨架直出（13 件）+ 骨架自检 |
| `contract.ts` | §九 结构化契约校验（覆盖性 + 缺 PUT + 空契约 + 删除后 404）+ 五个机器产物渲染 + 断言求值器 |
| `verify.ts` | §十一 九步真实验证（真命令）+ Evidence 唯一构造点 + `decideDone` 十条件 |
| `fakeLlm.ts` | §六 十种模式 + `fakeVerifyResult`（与真实验证同形，供编排器测试走同一条判据代码） |
| `steps/analyze.ts` | LLM 步骤 1：需求 → Spec（含 `openQuestions`：非空必须停） |
| `steps/plan.ts` | LLM 步骤 2：Spec → Plan（切片 + 文件白名单 + 单写者 + 引擎件禁入） |
| `steps/contract.ts` | LLM 步骤 3：契约校验 + 落盘；失败**留原始错误** |
| `steps/implement.ts` | LLM 步骤 4：`CodeChange[]` 形状校验 + 逐条过写盘闸（`applyChanges` 与 repair 共用） |
| `steps/repair.ts` | LLM 步骤 5：只吃**机器证据**（命令/退出码/stdout/stderr/当前文件/契约/白名单/预算） |
| `orchestrator.ts` | 确定性编排 + §十三 重试纪律 + §十四 统一完成判据 + 运行报告落盘 |

### 新增：`agents-CrewForge/engine2/tests/`（§十六 要求的确定性测试）

`harness.ts`、`run.ts`（总入口）、`state.test.ts`、`ledger.test.ts`、`child-crash.ts`、`fakellm.test.ts`、`workspace.test.ts`、`contract.test.ts`、`verify.test.ts`、`orchestrator.test.ts`、`testagent.test.ts`、`probe-testagent.ts`、`skeleton-build.test.ts`。

### 改造：`F:/code/agent/testAgent/`（独立 git 仓库，§十五）

- `src/context.ts`：新增 `Evidence` / `RepairRequest` / `RepairResult` 三个类型 + **纯函数路径闸门** `isRepairPathAllowed` / `isRepairBashAllowed` / `isUnder`（fail-closed：`allowedRoots` 为空即一律拒绝）。
- `src/main.ts`：新增 `runRepair(req): Promise<RepairResult>`；工具循环里插入**机械闸门**（`edit`/`write` 越界即拦截并回一条拒绝消息；`bash` 的写盘命令做 best-effort 路径检查）；结论只来自"重新执行原命令的退出码"，**不采信模型自述**；任何异常返回 `verdict:"error"` 的 JSON，不抛未处理异常。

### 文档

- `docs/superpowers/plans/2026-09-11-current-code-walkthrough.md`（第 0 步的《当前代码说明》）
- 本报告

---

## 2. 哪些旧模块仍然保留

**全部保留、零删除**（提示词明确"第一步不删旧代码"）：

`Hub.ts` / `BaseAgent.ts` / `GraphFactory.ts` / `merger.ts` / `maintainer.ts` / `manager.ts` / `architect.ts` / `backendEngineer.ts` / `frontendEngineer.ts` / `testEngineer.ts` / `projectRunner.ts` / `Node.ts` / `task.ts` / `common.ts` / `fileTools.ts` / `contracts.ts` / `checkers.ts` / `renderGate.ts` / `runEnv.ts` / `settings.ts` / `models.ts` / `llm.ts`，以及 `engine/**`（Ledger 试验版、IR、exec/static、exec/verify、workspace、steps、stacks）。

## 3. 哪些旧模块已停止参与新流程

**engine2 与旧控制平面之间是"零耦合"**，且由测试机械保证：

- `engine2/**` 不 import `Hub` / `BaseAgent` / `GraphFactory` / `merger` / `maintainer`——**架构测试直接扫 import 语句**（`workspace.test.ts`："engine2 禁令（机械断言，不靠自觉）"）。
- 消息总线、DB 节点/边、配对缓存、收敛记账在新流程里**没有任何入口**：engine2 的控制流是 `orchestrator.ts` 里的显式状态机 + Ledger。
- 旧系统的写盘口 `common.writeWorkspace`、契约散文 `CONTRACTS.md`、`expectedApisOf` 正则、`testEngineer` 纸审，在新流程里均**不被调用**（engine2 用自己的 `workspace` / `contract` / `verify`）。

## 4. Fake LLM 测试是否全部通过

**是。** `fakeLlm.ts` 十种模式全部有对应用例且全绿：

| 模式 | 用例结论 |
|---|---|
| 1-3 正常 Spec / Plan / Contract | 通过引擎校验，Spec 5 端点、Plan 2 切片、契约 5 端点 + 5 产物 |
| 4 缺 PUT 的 Contract | 被拒，`category=CONTRACT`，错误点名 PUT |
| 5 Contract 为空 | 被拒（"空契约不允许继续"） |
| 6 输出无法解析 | 结构化失败（`OutputParseError` → SPEC），**不崩进程** |
| 7 试图写未授权文件 | `WRITE_REJECTED reason=ENGINE_OWNED_FILE path=backend/pom.xml`，引擎件内容一字节未改 |
| 8 试图改 acceptance | 拒绝（`_engine2/**` 归引擎），`http-cases.json` 未被清空 |
| 9 试图伪造 verified | `AuthorityFieldViolation` 拦下，业务文件零落盘 |
| 10 连续生成相同错误 | 触发"同签名 + 文件无变化 → 不得再调 LLM"，只允许 1 次修复 |

另有权威字段扫描器自身的用例（嵌套 / 数组 / 大小写 / `expectedStatus` 不误伤 / 字符串 JSON 也扫描）。

## 5. 骨架是否能构建

**能，且是真跑出来的（不是静态检查）：**

| 项 | 命令 | 结果 |
|---|---|---|
| 前端 | `npm install` + `npm run build`（骨架 `frontend/`） | **exit=0**，产出 `dist/index.html`（本机 129.7s） |
| 后端 | `mvnw -B -DskipTests package`（骨架 `backend/`） | **exit=0**，产出可执行 jar（本机 15.7s，`~/.m2` 已热） |

骨架自检同时机械断言（`validateSkeleton`）：`index.html → src/main.ts`、router 含 `/`、`App.vue` 含「便签」、页面含 `<input>/<textarea>/<button>`、`schema.sql` 建 `note` 表、`application.yml` 从环境变量读库且**不写死密码**；并含反向用例"路由为空必须报错"。

## 6. Verifier 是否产生真实 Evidence

**是，且证据只能由 `verify.ts` 构造**（§十一 的九步顺序不可颠倒，测试已断言步骤序列）：

1 `files_exist`（真实 fs 检查）→ 2 `frontend_build`（缺 `node_modules` 时先真跑 `npm install`）→ 3 `backend_build`（`mvnw package`）→ 4 `backend_boot`（`java -jar` + 健康轮询，**编译不过不启动**）→ 5 `db_init`（真跑 `schema.sql` 到宿主 MySQL 临时库，`multipleStatements`）→ 6 `http_contract`（真打 6 条断言：5 端点 + 删除后 404，含 JSON 字段断言与 `id` 捕获）→ 7 `render`（`msedge --headless --dump-dom` 真开页面判白屏）→ 8 `evidence_saved`（落 `_engine2/evidence.json`）→ 9 判定 `verified`。
Evidence 结构 = `command / args / cwd / exitCode / stdout / stderr / durationMs / artifacts`（+ `step/httpStatus/note` 标注）；退出必清理（应用进程、预览进程、验证库全回收，测试已断言）。

## 7. testAgent 是否有路径限制

**有，且是代码级闸门（fail-closed）**：

- `edit` / `write`：`file_path` 必须落在 `allowedRoots` 内；项目目录之外（含 CrewForge 源码、testAgent 自身）、`.git`、项目根目录本身一律拒绝并回拒绝消息；`allowedRoots` 为空 = 一律不许改。
- `bash`：对**写盘形态**命令（`>`、`tee`、`sed -i`、`rm/mv/cp/del/mkdir` 等）做目标路径检查，项目外目标拒绝。**诚实标注**：bash 无法做语义级证明，这是 best-effort；机械闸门是 edit/write 那两条。
- 结论只来自重跑原命令的退出码；预算耗尽 → `incomplete`；异常 → `error`（返回 JSON，不抛未处理异常）。

测试：6 个用例覆盖"里面放行 / 外面拒绝 / .git / 项目根 / 空白名单 / bash 写盘"，外加**子进程真 import** 验证 `runRepair` 确实导出（不是 grep 出来的）。

## 8. 是否调用过真实 LLM

**没有。零次。**

## 9. 如果没有调用，说明原因

**原因是你的明确指令："不要跑 LLM 测试"。** 按要求我把全部工作收敛在确定性范围内（Fake LLM 十模式 + 假验证注入 + 真命令验证骨架构建），一次真实模型调用都没有发出。

需要如实说明的一点：§十七 的七条开启条件在本轮**已经全部满足**（`tsc exit=0`；engine2 确定性测试全绿；Fake LLM 全过；骨架前端 build 退出码 0；骨架后端 build 退出码 0；Ledger 崩溃恢复通过；权限与 done 防伪通过）。所以这里**不是**"因为条件未满足而不能跑"，而是"按指令未跑"。→ 因此我不套用提示词里那句"确定性测试尚未全部通过"，而是写成：**真实 LLM 测试按指令未执行（确定性条件已满足）**。

## 10. 当前是否达到进入真实 LLM 测试的条件

**达到**（七条全绿）。真要开跑时只需补两件事（本轮刻意未做，避免超出 §四 的文件清单）：

1. **真实适配器**：实现 `Llm` 接口的 `realLlm`（analyze/plan/contract/implement/repair 五步，走现有 `models.ts`/`sys_settings` 的端点配置），注入 `runEngine2({ llm })` 即可；FakeLlm 与它同接口，切换零改码。
2. **第一轮四下上限的执行脚本**：正常需求分析 1 次 / 正常契约生成 1 次 / 编译错误修复 1 次 / 页面错误修复 1 次，并按 §十七 保存输入、输出、token、耗时、修改文件、验证结果。

---

## 附 A：怎么跑

```bash
cd agents-CrewForge
bun x tsc --noEmit                                    # 类型闸（本轮 exit=0）
bun run engine2/tests/run.ts                          # 确定性测试（76 例；含真 build）
ENGINE2_SKIP_BUILD=1 bun run engine2/tests/run.ts     # 跳过两项真 build（视为未验证）
```
退出码：`0` 全绿 ／ `1` 有失败 ／ `2` 有阻塞（未验证）。程序化入口：`runEngine2({ runId, projectDir, requirementText, llm, ledger, verify? })`。

## 附 B：本轮的关键实现决定（含我踩到并修掉的真问题）

1. **单写者登记的键必须带 scope（项目目录）**：第一版只用路径做键，同进程里的多个项目/多次 run 会把同名文件误判成 `OWNED_BY_OTHER`（测试实锤后修）。这类"全局 Map 当控制状态"正是旧系统的病，engine2 里按 run/项目隔离。
2. **失败分类只看第一个失败步骤**：否则后端构建失败时，下游的 `db_init` 会被连坐并把整个失败误分类成 `ENV`，直接跳过修复（测试实锤）。
3. **编译不过不启动、前端构建不过不渲染**：省时且免误判（D-8），并有断言的步骤状态为证。
4. **`evidenceComplete` 的步骤名必须与 `steps` 同名**（`backend_boot`），否则 `verified` 会因为"证据不全"被静默降级——这类命名漂移是假通过的温床。
5. **`_engine2/**` 与 `_verify/**` 归引擎**：契约、验收、证据、报告全在引擎手里，任务写即拒。
6. **骨架页面与 API 文件也归引擎**：`frontend/src/views/NotePage.vue`（页面可独立构建、自带列表/表单/删除）与 `frontend/src/api/notes.ts`（由契约渲染器**唯一**渲染，骨架与契约共用同一渲染函数，防"两套清单"复发）。这两件不在你的原始 7+4 清单里，属我为了让骨架"可构建 + 页面可达"新增的引擎件，特此报备。
7. **verify 里补了一步 `npm install`（缺 `node_modules` 时）**：否则前端 build 必然假失败；这是"真命令"而不是网络模拟，装了才谈得上判定。
8. **验证是 run 级、修复是 slice 级**：按 §十一 的九步（build/boot/db/http/render）天然是 run 级；失败时用"第一个失败步骤"归责到对应 slice 再触发 repair，避免整树重做。

## 附 C：本轮未做（明确边界，不含糊）

- 真实 LLM 适配器与四次上限的真实调用（按指令）。
- 把 engine2 接进 `projectRunner` 的开关（旧系统保活；§四 只说"新增入口"，接线属下一步）。
- 前端运行报告页（§十八 未列，属主计划的 M8）。
- 删除任何旧代码（§一 明确本轮不删）。
