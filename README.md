# CrewForge

> 一句话启动一支虚拟开发团队：**产品经理 → 架构师 → 开发（单开发流，分批消费蓝图）→ 测试 → 维护收敛**，
> Web 控制台全程可视、可介入；**本地命令执行有三态权限闸门**，越权动作会停下来问你。
>
> 定位：Agent 编排能力的演示工程——取舍顺序 **演示效果 > 架构讲稿 > 代码质量 > 稳定性**。

## 仓库布局

**源码只有三层**，第一级一眼能分清是哪一层：

```
backend/      Java：Spring Boot 3 控制台后端（pojo / common / server 三模块）
frontend/     Vue 3 + Vite：Web 控制台
agent/
├── engine/      Bun + TypeScript：多智能体引擎（PM / 架构师 / 开发 / 测试 / 维护）
└── testAgent/   Bun + TypeScript：独立验收器（交付门前最后一道门）
deploy/       部署件（Dockerfile / docker-compose / nginx / 验证脚本）——非源码
docs/         蓝图与本地知识笔记（gitignore 排除，不入库）——非源码
```

> 2026-09-18 目录重构：`backed-CrewForge` → `backend`、`fronted-CrewForge` → `frontend`、
> `agents-CrewForge` → `agent/engine`、`testAgent` → `agent/testAgent`。
> 引擎产物树也从仓库根 `runs/` 改到 `agent/runs/`（仓库根不留跑出来的东西）。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Vue 3 + Vite + TypeScript + Pinia + vue-router（藏青/午夜蓝赛博朋克风） |
| 后端 | Spring Boot 3 + MyBatis-Plus + MySQL 8 + JWT（BCrypt 存口令）+ knife4j |
| 引擎 | Bun + TypeScript + LangChain.js / LangGraph.js（消息驱动 + 拆分图） |
| 验收器 | Bun + TypeScript，两种模式：`--verify` 只读验收（零 LLM、不写目标项目）／`--auto`·交互 可改码修复 |

> `agent/testAgent/` 原先在仓外（`F:/code/agent/testAgent`）单独一个仓库，2026-09-18 搬进本仓——
> clone 下来就自带裁判，不再依赖某台机器上的绝对路径。
> 接线在 `agent/engine/testAgentAdapter.ts`（默认 `path.resolve(import.meta.dir, "..", "testAgent")`，
> 可用 `TESTAGENT_DIR` 覆盖）。它与引擎之间是**手工镜像的契约**（跨仓不 import），改动一边时另一边要同步。

## 架构

```
┌───────────────┐  REST + JWT  ┌───────────────────┐  spawn (bun run projectRunner.ts)  ┌────────────────────┐
│ frontend :5173│ ───────────→ │  backend :8080    │ ─────────────────────────────────→ │ agent/engine       │
│ 看板/对话/审批 │ ←─────────── │ ProjectRun 进程管理│ ←───────────────────────────────── │ 消息版团队 + 拆分图   │
└───────────────┘ 轮询 sys_task │ sys_* 全部落库     │  回调 java_base_url（缓存清理等）    │ Hub 进程内消息总线    │
                                └─────────┬─────────┘                                    └──────────┬─────────┘
                                          │                    MySQL crewforge                        │
                                          └───────────────── sys_* ←───────────────────────────────────┘
                                              sys_task=引擎与看板的桥（任务为原子）
```

**架构定性**：message-driven hierarchical pipeline multi-agent —— workflow 骨架（门控/路由/计数/收敛全用代码），
LLM 只在工位上产出内容，**无运行时 supervisor**。

**团队消息协议**（`Hub.ts`，协议消息只带 taskId，数据真相在 `sys_task`）：

```
manager → architect : phase_plan       architect → developer : architect_task(蓝图) + architect_batch(逐批，按蓝图序)
developer → test-core : test_request   test-core → developer : test_passed / test_failure（受信名单闸 + acceptanceHash 自检）
developer → architect+maintainer : developer_started/progress/ready/blocked/failed（终态抄送记账方）
architect → maintainer : tasks_declared（派发前声明）    maintainer → architect : phase_done(含失败清单)
architect → manager    : phase_request（阶段收尾，runner 代发下一阶段）
```

**进程模型**：按阶段起进程——引擎跑完一个阶段即退出，Java 对账器（`status=executing` 且无活进程 → 重拉下一阶段）
30s 一轮续拉；崩溃恢复由 `sys_task` 状态机天然给出；连续 5 次续拉无进展则熔断置 `failed`。

## 命令执行权限（三态闸门）

本地命令执行是**唯一能真的弄坏东西**的地方（文件写入早就锁死在项目目录内），所以只对它设权限。

**三态**：`allow` ／ `ask`（弹卡问你）／ `deny`（硬拒，连问都不问）。
**分层来源**：`policy > project > user > session`，判定取**首个命中**（覆盖语义，不是合并）。

判定顺序（`PermissionRuleServiceImpl.decide`）：

```
⓪ 模式分流：全自动(0) → 直接放行（闸门整体旁路）
① 规则命中（按来源优先级）
② 危险 allow 规则剥离：命中也不作数，降级为 ask
③ 没命中 → 按模式决定：手动 = 白名单外一律问；混合 = 只有"有后果"的才问
```

**三个模式**（真相在 `sys_project.confirm_mode`，由后端自己读，不让调用方传 —— 传参就会出现
"引擎以为手动、库里是混合"这种不一致，而它的后果是"该拦的没拦"且没有报错）：

| 模式 | 命令权限 | 换阶段 | 预算 |
|---|---|---|---|
| 0 全自动 | 全部放开 | 不问 | 不设限 |
| 1 混合 | 只读/无后果放行；装依赖·写盘·连网·动库·跑脚本才问 | **要 yes** | 常规 |
| 2 手动 | 白名单之外一律问 | 要 yes | 常规 |

**审批卡**是对话流里的一小条（不占半屏、不挡执行日志与看板），固定给四样：**命令原文**、
**为什么问**、**选了"始终允许"会写入什么规则**（`Bash(npm install:*)`），三个按钮
`允许一次 / 始终允许 / 拒绝`。刻意不给的两样：`ruleContent` 为空时**不显示"始终允许"**
（那一下点击会退化成给整类命令开永久口子）；**权限卡超时按拒绝处理**（fail-closed ——
"超时=当你批准了"意味着挂机一晚足够让所有没人在看的破坏性命令跑完）。

**写入时校验**（挡在入库之前，而不是事后检测）：危险 allow（解释器/shell/包运行器/下载器前缀）
直接拒；会盖住既有 deny 的宽 allow 直接拒 —— 判定按来源优先级取首个命中，
`Bash(git:*)` 在 policy 层会盖住 project 层的 `Bash(git push:*)`，那条 deny 就永久失效了。
偏严方向（更宽的 deny 盖住 allow）不拦。

**通道复用 `sys_confirm`**：它本来就是 Claude Code 的 `permission.asked`（`pending → answered/auto_passed`、
`question_id` 幂等、`expire_at` 超时、引擎侧端点豁免 JWT、前端已在轮询），所以只补了三列：
`kind`（`permission` 审批卡 / `question` 问答卡）、`detail_json`（要执行什么）、
`decision`（`allow_once / allow_always / deny`）。规则表 `sys_permission_rule` 是新增的。

## 数据模型

MySQL `crewforge`，全表结构基线 `backend/sql/schema.sql`：

| 表 | 作用 |
|---|---|
| `sys_project` | 项目：需求 / 澄清清单 / 技术栈 / 开发计划 / 确认模式 |
| `sys_task` | 任务桥：引擎与看板的唯一真相（任务为原子） |
| `sys_project_file` | 产物代码（执行面板的文件树与编辑器读它） |
| `sys_confirm` | 挂起问答 + **权限审批**（两种卡共用一条通道） |
| `sys_permission_rule` | 命令执行权限规则：三态 + 分层来源 |
| `sys_settings` | 运行时配置（模型名/URL/key/回调基址，cc-switch 式单行） |
| `sys_agent*` / `sys_project_agent*` | 自定义 Agent 池与节点/连线声明（加入项目时**整表复制**，项目间互不干扰） |

## 快速起环境

```bash
# 1. 建库导基线
mysql -u root -p -e "CREATE DATABASE crewforge DEFAULT CHARSET utf8mb4"
mysql --default-character-set=utf8mb4 -u root -p crewforge < backend/sql/schema.sql
# 权限表（9/18 新增；含 sys_confirm 的三列扩展，存量行自动归为 question）
mysql --default-character-set=utf8mb4 -u root -p crewforge < backend/sql/migration_permission.sql

# 2. 后端（先按 application.example.yml 建 application.yml：DB 账号密码 + project-run 的 engine-dir/runs-root）
cd backend && ./mvnw spring-boot:run        # :8080

# 3. 引擎（先建 agent/engine/.env：DB_PASSWORD=*** DEEPSEEK_API_KEY=***）
cd agent/engine && bun install
#    模型走 sys_settings 设置页（Web/API 均可配，引擎 30s 热生效）
#    手动驱动（Java 未点开工时的调试入口，产物落 agent/runs/）：
PROJECT_ID=1 AUTO_CONFIRM=1 RUNS_ROOT=../runs bun run projectRunner.ts 1

# 4. 前端
cd frontend && npm install && npm run dev    # :5173
```

**验证脚本**：`pwsh deploy/scripts/verify.ps1`（三层的类型检查 + 引擎冒烟 + 前端构建 + 后端测试）。

## 运行成本

模型分档（T3 双档，粗估，live 实测校准）：demo 档（架构师/测试/前端 pro）≈ ¥8~20/轮；
回归档（全 flash）≈ ¥2~4/轮。切换零改码：设置页填「Pro 档模型」+ 角色档位 JSON，30s 热生效；都不填 = 全局名单档。

## 已知边界（诚实清单）

- **架构师确认门"混合模式要 yes"这条没跑过整机**：改的是 `confirmNode` 的两行分支，
  验的是 `decide` 端点与代码路径，没有真起一次引擎看那张 y/n 卡弹出来
- 一条 policy 层的 `Bash(*)` 会遮蔽所有细则（Claude Code 为此有 `shadowedRuleDetection`，我们没有）——
  但**写入时那道校验已经把它挡在入库前**，所以实际产生不了；库里已有的老数据仍需人工看
- **testAgent 本地跑还没接后端通道**：它用自己那套本地终端三选一（`agent/testAgent/src/permission.ts`），
  后端的审批通道目前服务引擎侧；规则真相虽只有一份（`sys_permission_rule`），但两边尚未打通
- 测试工位有机械三查（编译/色值/渲染真开页面）+ 六项清单纸审，但**"全树能 build"仍无物理证据**
- 渲染审依赖本机 Edge + 生成物 `bun install` 成功；起不来自动 skip 并带理由进测试报告（不静默、不拦路）
- **Windows 上带 pnpm `node_modules` 的目录不能直接改名**（pnpm 用绝对路径 Junction，改名后全断，
  且只表现为"某个包找不到"）—— 这条是 9/18 目录重构时踩出来的

## 说明

**第一代引擎归档（`_legacy-agents/`）已于 2026-09-17 移出工作区。** 它从来不参与构建/测试/类型检查
（零 import），26 个跟踪文件全部留在 git 里，随时可取回：

```
git show 4264873:_legacy-agents/manager.ts          # 看单个文件
git checkout 4264873 -- _legacy-agents              # 整体恢复到工作区
```

⚠️ 同目录下的 `.env` **从未进过 git**（被 `**/.env` 拦住），已随目录一起删除且不可恢复 ——
里面有一把 `TAVILY_API_KEY`（DeepSeek 那把与 `agent/engine/.env` 是同一把，副本而已）。
当前引擎代码没有任何一处读该变量，需要时去 Tavily 后台重签即可。
引擎源码里"移植自 `_legacy-agents/xxx.ts`"那几处注释是**历史出处说明**，文件删掉后这些说法依然成立。

`DeskTop-CrewForge` 桌面端为前端暴力拷贝，已封存于仓库外（`F:/code/_archive/`，真做时壳引用 web dist）。
