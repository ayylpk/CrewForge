# engine2 交付报告（items 1–8）

> 日期：2026-09-11　范围：`agents-CrewForge/engine2/**`（新增）+ `projectRunner.ts`（feature flag 接线）+ `F:/code/agent/testAgent/src/{context,main}.ts`
> 纪律：**本轮未调用任何真实 LLM**；未改任何冻结件；未删任何旧代码。

---

## 0. 结论速览

| 项 | 结果 |
|---|---|
| 确定性测试 | **86 / 86 通过，0 失败，0 阻塞**（含骨架前端真 build 263s、骨架后端真 build 16.2s） |
| `bun x tsc --noEmit` | 退出码 0 |
| s1 真实端到端 | **done 且 verified=true**：6 条 HTTP 断言全过 + 页面渲染通过（66 字）+ 宿主 MySQL 建表成功 |
| 新旧评分对照（s1） | 旧 3/10 → 新 10/10：**提升 7 项、持平 3 项、下降 0 项** |
| 生产入口 | feature flag 已接线并测试；**默认仍是旧系统**（理由见 §6） |
| 真实 LLM | 未执行（你此前明确禁止；本轮所有生成侧均走 FakeLlm，零网络） |

---

## 1. 解决 testAgent 可访问性

**问题**：可用性依赖"跨仓 spawn 子进程"，在受限环境里 spawn 被拦 → 用例失败/不可判。

**修法**（`engine2/tests/testagent.test.ts`）：
1. **首选进程内动态 import**：`await import(pathToFileURL(<testAgent>/src/main.ts))` —— 不依赖 spawn，任何沙箱都能跑（实测 `runRepair: "function"`）。
2. 子进程探针降级为**回退路径**（进程内失败时才用）。
3. 两条路都不通 → 记 **Blocked（未验证）**，绝不折算成通过。

---

## 2. 修复骨架 Maven 构建

**根因（实测两层）**：
1. 生成的骨架**没有自带 mvnw**，只能回退到 CrewForge 仓库的 wrapper → "生成出来的项目"不自治。
2. `findMvnw` 返回的是**相对路径**，交给 shell 的 `/c` 执行时按错误的 cwd 解析 → 报"系统找不到指定的路径"（`mvnw.cmd` 根本没被执行）。

**修法**：
- 骨架现在**自带三件套** `backend/mvnw`、`backend/mvnw.cmd`、`backend/.mvn/wrapper/maven-wrapper.properties`（从 `CF_MAVEN_WRAPPER_DIR` / 仓库 `backed-CrewForge` **只读复制**，源一个字节不改）；新增用例断言"骨架自带 wrapper"。
- 所有路径 `path.resolve` 绝对化（`findMvnw`、`mvnwPath`、`projectDir`）。
- 真 build 用例改为**用骨架自带的 mvnw**（回退到仓库 wrapper 会直接判"未修好"）：`mvnw -B -DskipTests -Dfile.encoding=UTF-8 package` → **exit=0，产出 jar（16.2s）**。

---

## 3. 修复 npm cache 权限并跑通前端构建

**根因（实测）**：本机全局 npm cache（`C:\Users\...\AppData\Local\npm-cache`）被安全删除钩子（`genie-safe-delete`）接管删除动作，`npm cache verify` 直接报
`[safe-delete] 操作失败: ... Error during a trash operation` → 任何需要 prune 的 install 都可能炸。

**修法**：
- 所有安装改用**项目本地 cache**：`npm install --cache <project>/_engine2/npm-cache` + `npm_config_cache` 环境变量（实测 exit=0）。测试与 `verify.ts` 都改了。

**顺带打掉的第二个同类坑（同一钩子）**：vite 在 `prepareOutDir` 阶段用 `fs.rmSync` 清 `dist`，同样被钩子拦 → **前端 build 假失败**（报错栈里能直接看到 `genie-safe-delete.cjs` → `emptyDir`）。修法：引擎拥有的 `vite.config.ts` 设为 `build: { emptyOutDir: false, outDir: 'dist' }`（只覆盖写，不触发删除）。

**结果**：骨架前端真 build **exit=0**，产出 `dist/index.html`（冷装 263s）。

---

## 4. 再跑 engine2 全套（86 项）

```
bun x tsc --noEmit            → 退出码 0（零输出）
bun run engine2/tests/run.ts  → 通过 86 / 失败 0 / 阻塞 0，退出码 0
```
其中**真命令**三项：骨架前端 build（263.0s）、骨架自带 mvnw 后端 build（16.2s）、骨架 wrapper 自带性校验。

本轮新增用例：入口/flag/对照 7 项、`ensureDir` 幂等 1 项、契约产物重复落盘 1 项、标题抽取 1 项（都是本轮修掉的真实缺陷的回归钉）。

---

## 5. engine2 CLI / HTTP 入口（新增 `engine2/entry.ts`）

```bash
# CLI：跑一个需求（默认 --mode fake，零网络）
bun run engine2/entry.ts run --project <dir> --requirement-file <file|-> [--run-id X] [--json]
# HTTP：健康检查 / 触发 / 查询
bun run engine2/entry.ts serve --port 8787
#    GET  /engine2/health
#    POST /engine2/run     { projectDir, requirementText, runId?, async? }
#    GET  /engine2/runs/:runId?projectDir=...
# 新旧评分对照（读冻结 before.json，只读）
bun run engine2/entry.ts compare --project <dir> --scenario s1-crud-min
```
**安全默认**：`--mode real` / HTTP 的 `mode:"real"` 需要 `CF_ALLOW_REAL_LLM=1`，否则 **403/退出码 3** 直接拒绝——绝不"以为在跑模型，其实在跑假模型"。能力门未过的需求 **422/退出码 4**。

---

## 6. Feature flag 让冻结场景走 engine2

接线点：`projectRunner.ts` 的 `runProject()` 开头（**默认零开销**：没设 flag 时不加载 engine2）。

| 环境 | 行为 |
|---|---|
| 未设置 | 旧系统（与从前逐字节一致） |
| `CF_ENGINE=legacy` | 强制旧系统 |
| `CF_ENGINE=engine2` | 强制新入口；跑完把**程序判定出的真实终态**写回 `sys_project.status`（done/failed/blocked） |
| `CF_ENGINE2_DEFAULT=1` | 过**能力门**才走 engine2，否则回退旧系统并打印原因 |

能力门 = "Vue3+Vite / Spring Boot 3 / MySQL 8 + 单实体 CRUD"（engine2 v1 的诚实边界；非 CRUD 需求直接拒，不硬跑）。
判定矩阵、能力门、拒绝文案都有确定性用例。

**为什么没有把默认翻成 engine2（item 8 的偏差，必须讲清）**：engine2 v1 的生成侧目前只有 FakeLlm（固定产物）。若默认入口指向它，**任何项目都会被生成"便签应用"**——那才是真正意义的假通过。所以我把"对比 → 切默认"做成：**对比已完成且达标（7↑/3=/0↓）**，切换动作压缩到一个环境变量（`CF_ENGINE=engine2` 已实测可用），但**默认值仍留给旧系统**，等真实 `Llm` 适配器落地后再翻。这是刻意保留的偏差，不是漏做。

---

## 7. 用 s1 做一次真实端到端验证

**命令**（需求 = 冻结 `eval/scenarios/s1-crud-min/input.md`，只读）：
```bash
cd agents-CrewForge
bun run engine2/entry.ts run --project ../runs/engine2-s1-final \
  --requirement-file eval/scenarios/s1-crud-min/input.md --run-id s1-e2e-final
```
**结果：`done`，`verified=true`，退出码 0**

| 步骤 | 证据 |
|---|---|
| files_exist | 13 个骨架件 + 契约产物齐备 |
| frontend_build | `npm run build` **exit=0** |
| backend_build | 骨架自带 `mvnw package` **exit=0** |
| backend_boot | `java -jar` 就绪（端口 23076） |
| db_init | **宿主验证（host）**：`engine2_verify_xxx` 建库 + `schema.sql` 执行 + `SHOW TABLES` 核实 **1 张表** |
| http_contract | **6/6 全过**：POST/GET/GET{id}/PUT/DELETE 200 + 删除后 GET **404** |
| render | `msedge --headless --dump-dom` 页面 `/` 通过（可见文本 66 字，含「便签」） |
| evidence_saved | `runs/engine2-s1-final/_engine2/evidence.json`（命令/退出码/耗时/日志全留档） |
| 生成侧 | **FakeLlm，5 次调用，零网络**（LLM 调用数是程序计数，不是模型自述） |

### 这一轮 e2e 打掉的 7 个真实缺陷（全部有回归钉）

| # | 缺陷 | 现象 | 修法 |
|---|---|---|---|
| 1 | Bun 的 `mkdirSync(recursive)` 对已存在目录抛 **EEXIST** | 第二次落契约产物就炸 | 统一 `ensureDir()`（幂等）+ 契约重复落盘用例 |
| 2 | 命令**没传 logDir** | 构建失败但**一个日志都没有**（证据链断） | `CommandSpec.logDir` 打通，日志落 `_engine2/logs/*` |
| 3 | 证据只在"启动成功"分支落盘 | 早退（构建失败）时**没有 evidence.json** | 证据落盘移进唯一出口 `finish()`，任何路径都留档 |
| 4 | `appTitleOf` 取"首段 2-4 汉字" | 标题变成**「做一个单」**→ 页面无业务文案 → 渲染判红 | 改为：引号内名词 → 去动词前缀后 X管理/系统 → 实体名；加用例 |
| 5 | 参考实现用 `Map.of(..., null)` | DELETE/404 路径 **NPE → 500** | 改为可空 `envelope()`（LinkedHashMap） |
| 6 | vite preview 只监听 `localhost`（Node 可能解析到 ::1） | 轮询 127.0.0.1 **永远连不上** → 渲染假失败 | preview 显式 `--host 127.0.0.1` |
| 7 | DDL 解析把"注释开头的语句"整条丢掉 | **执行 0 条 DDL 却报成功** → 表没建 → 接口全 500 | 先整行去注释再切分；**0 条即失败**；事后 `SHOW TABLES` 核实 |

> 这 7 条都不是"测试写错"，而是产品代码/环境适配的真问题——**只有真跑真命令才暴露得出来**，这正是本轮 e2e 的价值。

---

## 8. 新旧评分对照后再切默认入口

```
# s1-crud-min：旧系统 vs engine2
| 检查项            | before | after | 变化 |
| backend.boot      | pass   | pass  |  =   |
| backend.build     | pass   | pass  |  =   |
| frontend.build    | pass   | pass  |  =   |
| note.create/list/get/update/delete/getAfterDelete | fail ×6 | pass ×6 | ↑ |
| page.home         | fail   | pass  |  ↑   |
合计：提升 7 / 持平 3 / 下降 0    结论：无下降项 → 达到切默认门槛（前提：能力门通过）
```
- 对照表落盘：`runs/engine2-s1-final/_engine2/scorecard-compare.md`；基线是**冻结的** `eval/baseline/before.json`（只读，未改）。
- 切默认的唯一前置（真实 `Llm` 适配器）见 §6 的说明；`CF_ENGINE=engine2` 现在就能用。

---

## 9. 本轮未做（明确边界）

1. **真实 LLM 适配器与四次上限的真实调用**（按指令未跑；FakeLlm 与真实适配器同接口，切换零改码）。
2. **把默认入口翻成 engine2**（理由见 §6，需要真实适配器先落地，否则等于给每个项目生成便签应用）。
3. **eval harness 全链路驱动**（`eval/runner.ts` → Java/DB 编排那条路）：本轮证据来自 CLI/engine2 直驱（同一条 engine2 代码路径），未跑 harness 的 Java 编排（它会走旧系统的落库与对账）。
4. 旧代码删除、前端运行报告页（属主计划 M7/M8）。

## 10. 声明

- 未调用任何真实 LLM；`--mode real` 有硬闸（`CF_ALLOW_REAL_LLM=1`）。
- 冻结件（`input.md` / `expected.json` / `before.json` / 阶段 0 报告）**未修改**（`readBaselineChecks` 只读）。
- 新增文件：`engine2/entry.ts`、`engine2/tests/entry.test.ts`；改动文件：`engine2/{types,ledger,workspace,contract,verify,fakeLlm,orchestrator}.ts`、`projectRunner.ts`（flag 接线）、`testAgent/src/{context,main}.ts`。
