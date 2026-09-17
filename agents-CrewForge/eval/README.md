# eval/ —— CrewForge 评测基准（阶段 0）

> 目的：**先有尺子，再改代码**。本目录只做一件事——用**当前系统真实运行结果**回答
> "这份冻结需求，它到底能不能交付"。
>
> 铁律（写进代码，不靠自觉）：
> 1. 任何 `pass` 必须绑定真实命令 + 退出码，或真实 HTTP 状态码 + 逐字段断言；
> 2. 静态 grep / 正则 / LLM 文字**不得单独产生 pass**；
> 3. 判定不出来的一律 `blocked`（**未验证 ≠ 通过**），绝不折算成通过。

## 目录

```
eval/
  scenarios/<id>/input.md        冻结的需求原文（写好后不许改；作为 sys_project.description 注入旧系统）
  scenarios/<id>/expected.json   机器可比对的期望：接口 / 页面 / 构建命令 / 启动命令 / HTTP 断言 / 渲染断言
  harness/                       采集实现（env 探针 / 现场准备 / 命令执行 / 检查 / 驱动旧系统）
  baseline.ts                    历史产物静态基线（既有脚本，不动）
  scorecard.ts / collect.ts      既有评分卡与快照采集（不动）
  runner.ts                      ★ 跑一个/全部场景：旧系统 + 构建 + 启动 + HTTP + 渲染
  report.ts                      ★ 汇总成 baseline/before.json + baseline/before.md
  baseline/env.json              环境事实（机器生成）
  baseline/before.json           ★ 阶段 0 基线（机器生成，字段稳定）
  baseline/before.md             ★ 人类可读报告（机器生成）
  baseline/runs/<场景>/          逐场景的 result.json 与原始日志（stdout/stderr/构建/渲染）
```

## 三个冻结场景

| 场景 | 类型 | 期望失败？ | 考什么 |
|---|---|---|---|
| `s1-crud-min` | 最小 CRUD | 否 | 前后端能否真的 build 起来 + 5 个接口真打（含删除后 404）+ 页面非白屏 |
| `s2-auth` | 登录/鉴权 | 否 | JWT 闭环：登录拿 token → 带 token 取 me → 无 token 401 → 错密码 401 |
| `s3-contract-mismatch` | 需求内部契约冲突 | **是** | 需求里写死两套互斥的路径/字段（`/api/users`+`data.items` vs `/api/user/list`+`data.list`）。**看系统会不会静默报完成** |

`expected.json` 只写**输入需求里真的写了**的东西（`runner.ts --validate` 会强制校验路径前缀出现在 input.md 里）。

## 跑法（cwd = `agents-CrewForge`）

```bash
# 0) 夹具自检（零 LLM、零副作用）
bun run eval/runner.ts --validate

# 1) 跑全部场景（串行；每个场景会新建一行 sys_project，不复用历史项目）
bun run eval/runner.ts --all --timeout-min 40

# 2) 只驱动旧系统（不跑检查），或复用已有产物只重跑检查
bun run eval/runner.ts --scenario s2-auth --phase run
bun run eval/runner.ts --scenario s2-auth --reuse-run

# 3) 汇总报告
bun run eval/report.ts              # 重新探环境（会起子进程）
bun run eval/report.ts --reuse-env  # 复用 baseline/env.json
```

**可重复性**：每次运行都会新建 `sys_project` 行、清空该项目的 `sys_task`、并在
`eval/baseline/runs/<场景>/` 下覆盖结果与日志；`--reuse-run` 可只重跑检查而不重烧 LLM。

## 环境前置（缺失不会伪造通过）

| 依赖 | 缺了会怎样 |
|---|---|
| MySQL（`.env` 的 `DB_*`） | 旧系统无法读库 → 直接失败；生成的应用无法启动 → 启动/HTTP 判 `blocked` |
| 模型端点（`sys_settings.model_url/api_key`） | 旧系统零产出 → 场景记为失败/无法判定 |
| JDK 17 + Maven wrapper | 后端构建判 `blocked`（不启动、不打接口） |
| Docker | 旧系统的 run 级验证必然 `skipped_unverified`（**不代表通过**）；本 harness 改用宿主 MySQL 实测并如实标注 |
| headless 浏览器（Edge/Chrome） | 渲染断言判 `blocked` |

## 结果怎么读

- `verdict.overall`：`pass` / `partial`（有通过也有无法判定）/ `fail`（有真实失败）/ `blocked`（全都判定不了）
- `verdict.fakePass`：真实断言有失败，但旧系统报 `status=done` 且 run 级验证 `ok` → **假通过**
- `verdict.doneButUnverified`：旧系统报 `done` 但 run 级验证是 `skipped_unverified` → 诚实，但不等于通过
- 每个 `check` 都带 `command` / `cwd` / `exitCode` / `httpStatus` / `evidence` / `logFile`，可逐条复核
