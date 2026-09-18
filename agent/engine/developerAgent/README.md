# developerAgent —— Developer 独立替换模块

**定位**：Claude Code 式的 Developer Agent。不限制"能执行什么命令"，限制"命令能访问什么环境"。
保留 Hub 通信，不依赖 GraphFactory、节点链接和用户可编辑配置。做完后整块替换进默认启动路径。

一句话概括改造：**命令自由 + 环境隔离 + TestAgent 独立裁决。**

---

## 目录结构

```
agents-CrewForge/developerAgent/
├─ index.ts                  # 对外入口（装配 Workspace → Tools → Graph → Hub/Ledger）
├─ hubAdapter.ts             # Hub 收发适配（信任链 + 重复投递幂等）
├─ protocol.ts               # 消息类型、信任校验、权威字段禁令
├─ state.ts                  # Developer 状态机、判定纪律、Skill 调度
├─ graph.ts                  # LangGraph 图（写死）+ 命令指纹 / 超时策略 / 工具循环
├─ ledger.ts                 # 持久化真相：节点、工具、失败、进程、违规、checkpoint
├─ workspace.ts              # 读 / 写 / 执行 的唯一闸门（含快照与保护路径）
├─ tools/
│  ├─ registry.ts            # 工具注册表 + 角色闸门（写盘 ∪ 执行 ∪ 进程）
│  ├─ processSandbox.ts      # ★ 隔离边界：能力探测 / 环境清洗 / 网络策略 / 违规检测
│  ├─ processManager.ts      # ★ 长驻进程：登记、增量读取、进程树终止、按任务清理
│  ├─ shell.ts               # ★ 完整 shell 命令字符串
│  ├─ httpRequest.ts         # ★ 本机 HTTP 调试（默认只放行回环）
│  ├─ processTools.ts        # ★ startProcess / readProcess / stopProcess
│  ├─ runCommand.ts          # 任意可执行程序（无命令白名单）
│  ├─ runBuild.ts            # 前后端构建快捷方式（命令按工程文件识别，见 projectCommands；不是唯一入口）
│  ├─ projectCommands.ts     # ★ 按工程文件识别构建命令（mvnw/gradlew/package.json/pyproject/go.mod；识别不到=NO_BUILD_ENTRY 不猜）
│  ├─ testAssistant.ts       # 只读分析助手 / TestAgent 工具盒
│  └─ …（inspectTree / readFile / writeFile / editFile / mkdir / search / gitDiff）
├─ prompts/  system.md · task.md · repair.md
├─ skills/   inspect-project · bootstrap-project · backend/frontend/database-development · debugging · verification
├─ policies/ workspace-policy.json · tool-policy.json · retry-policy.json
└─ tests/    共 16 个零 LLM 测试文件（223 条）
```

## 命令执行策略（规格二）

**Developer 没有命令白名单。** 编译器、包管理器、脚本、HTTP、本地服务都能跑：

| 场景 | 工具 |
|---|---|
| 一次性命令（command/args 分开） | `runCommand` |
| 完整 shell 字符串（管道 / 重定向 / 串联） | `shell`（Win: `cmd /c` 或 PowerShell；Unix: `sh -lc`） |
| 前后端构建快捷方式 | `runBuild` |
| 本机接口调试 | `httpRequest`（GET/POST/PUT/DELETE/PATCH/HEAD） |
| 长驻服务 | `startProcess` → `readProcess`（增量） → `stopProcess` |

`commandAllowlist` 仍在，但**降级为部署环境安全策略**：不传 = 不限命令种类；
显式配置才生效，命中返回 `DEPLOYMENT_COMMAND_DENIED`（不是 `COMMAND_NOT_ALLOWED`）。

## 沙箱实际提供了什么（规格三）

代码与文档都必须承认一件事：**"cwd 设成项目目录"不是沙箱。**
所以这里把能力分两档，并且**拒绝把软档冒充硬档**：

| | 硬档 `realIsolation: true` | 软档 `softIsolation: true` |
|---|---|---|
| 触发条件 | `backend=docker` 且守护进程与镜像可用 | 显式 `mode: "soft"` |
| 文件系统 | 容器内挂载，宿主默认不可见 | 只能**检测 + 打断**越界写入 |
| 网络 | 由 `--network` 决定 | 只有策略，无法强制拦截 |
| 环境变量 | 容器边界重新给 | 宿主环境清洗后继承 |
| 用途 | 生产 | **仅单元测试与显式知情场景** |

**默认配置（`strict` + `backend=none`）在本机拿不到硬档时，命令根本不执行**，
返回结构化 `SANDBOX_UNAVAILABLE`；真实模式下任务直接 `blocked`，绝不静默降级为宿主裸跑。

### 本机 soft 冒烟模式（2026-09-13 定稿，暂不实现 Docker）

当前阶段的真实 LLM 冒烟用 **`mode: "soft"` + `backend: "local"`**：
命令真的在**本机**执行，受约束，但**不是隔离**。所有结果都明确标记

```
realIsolation = false
softIsolation = true
backend       = local
```

**它做不到什么（这 6 条不许在任何报告里省略）：**

1. 子进程仍然拥有宿主机用户权限；
2. cwd 限制不是安全隔离 —— 子进程理论上可以读取项目外的文件；
3. 项目外写入只能靠快照检测 + 轮询打断，**不能绝对阻止**；
4. 网络访问无法由 soft 模式强制隔离；
5. Windows 进程树终止使用 `taskkill`，属于 best-effort；
6. 仅用于本机开发与真实 LLM 冒烟，**不得用于生产运行不受信生成代码**。

生产部署仍然**禁止**使用本机 soft 模式；默认 `strict` + 无真实后端 = `blocked`。
`live/runner.ts` 不传 `--sandbox` 时默认就是 `strict`。

```bash
cd agents-CrewForge
bun run developerAgent/live/runner.ts \
  --task developerAgent/live/mysite/T1-foundation.json \
  --project F:\code\project\CrewForge\.runs\developer-local\live-1 \
  --sandbox soft --reset
```

runner 会在启动横幅里打印 `mode / backend / realIsolation / softIsolation / limitations`，
并在 `.runs/developer-local/_reports/` 下写出 JSON + Markdown 运行报告（含隔离程度、违规记录、
进程事件）；退出前 `await shutdown()` 清理遗留进程，`SIGINT/SIGTERM` 也有兜底清理。
项目目录必须是独立目录（默认 `.runs/developer-local/<runId>`），**禁止**直接跑在仓库根或控制平面内。

软档实际做到的边界：

1. 环境清洗：密钥类变量按名字删除（`DEEPSEEK_API_KEY` / `DATABASE_PASSWORD` / `*_TOKEN`
   / `*_SECRET` / SSH 相关…），只记名字不记值；
2. cwd 限定在生成项目内，并做 `realpath` 复核防符号链接逃逸；
3. 进程树超时终止（POSIX 进程组 / Windows `taskkill /T`，失败降级并如实报告 `killMethod`）；
4. 输出上限 + 截断标记 + 原始输出落盘路径；
5. 保护路径（控制平面源码 / `.git` / `CONTRACTS.md` / `_verify` / `_engine2`）执行前后快照对比，
   执行期间按 `watchIntervalMs` 轮询，命中即终止进程树并写违规记录；
6. Ledger 用"只降不升"的完整性探针保护（它由宿主自己持续写入，用 mtime 监视必然误报）；
7. 进程数上限、`cleanupTaskProcesses()`（任务完成 / 取消 / 崩溃恢复都会清理）。

软档**做不到**的（照实说）：子进程持有宿主用户权限，能读到项目外的文件；
越界写入是轮询粒度的检测/打断，不是阻止；子进程网络无法强制拦截。

每条执行结果（`runCommand` / `runBuild` / `shell` / `httpRequest` / 进程三件套）都自带
`realIsolation` / `softIsolation` / `sandboxMode` / `sandboxBackend` 四个字段，
**任何一个下游都不该把 soft 读成"已经隔离好了"**。

## 角色权限（规格六）

| 角色 | 读项目 | 写项目 | 执行命令 | 起进程 | 本机 HTTP |
|---|---|---|---|---|---|
| Developer | ✅ | ✅（`frontend/` `backend/`） | ✅ 任意 | ✅ | ✅ 回环 |
| TestAgent | ✅ 只读工具 | ❌ | ❌ | ❌ | ❌ |
| PM / Architect / Document | ❌ | ❌ | ❌ | ❌ | ❌ |

闸门在 `tools/registry.ts` 的 `PRIVILEGED_TOOLS`（代码强制，不看 prompt）。
Developer 自己的 build / grep / HTTP 结果**只能用于调试**，不能产生 `verified=true`——
只有独立 TestAgent 通过固定验收并把证据绑定到当前文件快照，才允许 Orchestrator 写入。

## 效率机制（规格五）

- 命令指纹 = 工具 + command + args + cwd + **当前项目源码快照**；同一快照下的重复命令直接复用结果；
- 文件没变化就不重复跑同一条构建；文件变了才重跑；
- `httpRequest` / `startProcess` / `readProcess` / `stopProcess` **永不缓存**（缓存等于伪造验证结果）；
- 超时被杀的命令不入缓存——它没有结果可复用；
- 默认超时：命令 2min / 构建 10min / 服务启动 2min / HTTP 30s；
- 允许主动延长一次超时，但必须给 `timeoutReason`（落 Ledger）；
- 同一命令连续超时两次 → `TIMEOUT_REPEATED`，停止重试并上报；
- 进程的启动 / 轮询 / 停止都写 Ledger（`process_event` 表）。

## 铁律（继承 2026-09-12 项目记忆）

- **Developer 是唯一可修改生成项目文件的角色**；写盘必须经 `workspace.ts`：仅 `allowedRoots`、
  禁 `.git`、禁 CrewForge 控制平面、禁 `_engine2` / `_verify` / Contract / acceptance / 测试脚本、
  防路径逃逸、临时文件 + 原子替换、记录 path/owner/时间/任务 ID。
- Developer 不得修改 Ledger、Contract、acceptance、TestAgent 测试脚本、`.git`、控制平面。
- TestAgent 只返回机器证据，不改代码；子 Agent 只读，只能分析、搜索、解释错误。
- `done` / `verified` 只能由外部测试与 Orchestrator 判定，Developer 不得自证。
- 用户不能编辑 Prompt，数据库不能覆盖 Prompt。
- 不得用改契约、删测试、放宽断言、伪造输出的方式消除错误。
- 不得为了通过测试保留静默降级。

## 运行与验证

```bash
# 类型检查（在 agents-CrewForge 下）
bun x tsc --noEmit

# 零 LLM 测试（在 developerAgent 下）
bun test tests
```

**本次改造阶段（2026-09-13）没有运行真实 LLM** —— 只跑了 TypeScript 检查与零 LLM 单元测试。
真实 LLM 冒烟**已放开**（`live/runner.ts --sandbox soft`），但由人显式发起、单独记录；
`live-llm-smoke.ts` 仍不在自动化验证范围内。

## Hub 消息（本模块收/发）

`architect_task`、`developer_started`、`developer_progress`、`test_request`、`test_failure`、
`test_passed`、`repair_started`、`repair_finished`、`developer_ready`、`developer_blocked`、
`developer_failed`

## 本阶段不做

用户自定义 Prompt / 用户改角色 / 用户改 Graph / 用户改节点配置 / 真实 MCP / 多 Agent 同时写项目 /
backendEngineer 与 frontendEngineer 分开写盘 / merger 拼接代码 / Docker 隔离后端 / 第二条技术栈。
