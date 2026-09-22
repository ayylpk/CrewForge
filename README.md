# CrewForge

> 输入一句需求，看着一支 AI 开发团队把它做成能跑的项目。
>
> 产品经理 → 架构师 → 开发 → 测试 → 维护，一条流水线跑到底：需求被反复问清、方案拆成阶段、
> 代码真的落盘、命令执行过权限闸门、交付前必须过一道**独立验收器**。控制台全程可视，随时能叫停。

定位：**Agent 编排的演示工程**——把 LLM 放进有门控、有验收、有人在环上的流水线里，让它从"会说"变成"能交付"。

```
需求 ──► PM 澄清 ──► 架构师拆阶段/出蓝图 ──► 开发分批写码 ──► 独立验收 ──► 维护收敛 ──► 可下载的项目
            ▲                ▲                   ▲               │
            └───── 确认门 / 命令审批卡 / 权限闸门 ───┴───────────────┘   人在环上
```

## 它和单 Agent 编码助手的区别

| | 单 Agent 助手 | CrewForge |
|---|---|---|
| 组织 | 一个 Agent 从需求干到代码 | 五个工位分工，靠消息协议交接 |
| 谁决定下一步 | 模型 | **代码里的 workflow**（门控/路由/计数/收敛），模型只在工位产出内容 |
| 需求 | 直接开写 | PM 多轮澄清，落库成确认清单才准开工 |
| 质量 | 模型自测 | **独立验收器**跑真实构建与接口断言，模型说"我做完"不算数 |
| 出错 | 无声跑偏 | 无进展保险丝 + 预算检查点（到阈值停下来问你） |
| 成本 | 不透明 | token 记账、模型分档、并发与槽位限制 |

## 架构

```
frontend :5173 ──REST+JWT──► backend :8080 ──spawn bun──► agent/engine（多工位团队 + 消息总线 Hub）
  看板/对话/审批 ◄──轮询 sys_task── 项目·任务·文件·审批·进程对账 ◄──HTTP 回调── 写文件/跑命令/调模型
                                        └──── MySQL crewforge（sys_* = 任务真相）────┘
                                        产物树：agent/runs/p{项目ID}/（源码 + 证据 + 报告）
```

- **后端是控制面**，**引擎是执行面**；两者只靠 `sys_task`（任务为原子）+ 几个回调端点通信。
- **进程模型**：按阶段起进程——跑完一个阶段就退出，Java 对账器（30s 一轮）拉起下一阶段；
  状态留在库里，重启可断点续跑，连续 5 次无进展熔断。
- **预算不是刹车是检查点**：到阈值（默认 120 分钟 / 400 次调用）不杀任务，而是组一道题问你
  （继续 / 加时 / 停）后静默等待；等不到回答就保状态退出，任务留在 `waiting_human`，下次拉起会再问。

## 多智能体

| 工位 | 职责 | LLM |
|---|---|---|
| Manager（PM） | 多轮澄清需求，产出确认清单 | 3 节点图 |
| Architect | 定栈、拆阶段、出蓝图与接口契约、分批下发 | 8 节点拆分图 |
| Developer | 单开发流：写码 → 本地预演 → 送检 → 按失败修复 | 13 节点图 |
| TestEngineer | 调起独立验收器，把机器证据译成 `test_passed / test_failure` | 纯判定 |
| Maintainer | 收敛终态、记账、发 `phase_done` | 零 LLM |

协议（只带 taskId，数据真相在 `sys_task`）：

```
manager→architect: phase_plan        architect→developer: architect_task + architect_batch
developer→test-core: test_request    test-core→developer: test_passed / test_failure
developer→architect+maintainer: started/progress/ready/blocked/failed
architect→maintainer: tasks_declared  maintainer→architect: phase_done  architect→manager: phase_request
```

## 安全与护栏

- **写入锁在项目目录内**：路径逃逸检查、`.git`/控制面/证据目录禁区、**先读后写**（没读过的文件不许整体覆盖）、单批写入与文件大小上限。
- **命令执行三态闸门**：`allow / ask / deny`，来源优先级 `policy > project > user > session`（取首个命中）；
  危险 allow 规则会被剥离降级为 ask；写入宽规则时会拒绝那些会遮蔽既有 deny 的写法。
  **审批卡超时按拒绝处理**（fail-closed）。
- **三种运行模式**（存库，不让调用方传参）：`0 全自动` 全放开 / `1 混合` 只问有后果的 / `2 手动` 白名单外一律问。
- **其他**：栈一致性检查、送检前验收预演、无进展保险丝、token 记账、接口所有权校验（防 IDOR）、
  引擎回调端点单独豁免 JWT 且只开三个。

## 技术栈

| 层 | 技术 |
|---|---|
| 控制台前端 | Vue 3.5 · Vite 8 · TS · Pinia · vue-router（无组件库，UI 手写：「晒图室」纸面风格，见 `frontend/DESIGN.md`） |
| 控制台后端 | Java 17 · Spring Boot 3.2 · MyBatis-Plus · MySQL 8 · Redis（300ms 超时兜底） · JJWT · BCrypt · knife4j |
| 引擎 | Bun · TypeScript · LangChain.js / LangGraph.js |
| 独立验收器 | Bun · TypeScript（`--verify` 只读验收，机械段零 LLM / `--auto` 可改码修复） |

## 仓库结构

```
backend/    Java 控制台后端（common / pojo / server 三模块 + sql 基线与迁移）
frontend/   Vue 3 控制台（views 八个页面 / components / api / composables）
agent/
├── engine/       多智能体引擎（projectRunner.ts 是入口；developerAgent/ 是开发工位）
└── testAgent/    独立验收器（skills/ 是验收技能库）
```

不入库（`.gitignore`）：`**/application.yml`、`**/.env`、`agent/runs/`、`node_modules/`、`target/`、`dist/`。

## 快速开始

前置：JDK 17、MySQL 8、Redis（可选）、[Bun](https://bun.sh) 最新稳定版、Node ≥ 20。

```bash
git clone https://github.com/ayylpk/CrewForge.git && cd CrewForge

mysql -u root -p -e "CREATE DATABASE crewforge DEFAULT CHARSET utf8mb4"
mysql --default-character-set=utf8mb4 -u root -p crewforge < backend/sql/schema.sql
mysql --default-character-set=utf8mb4 -u root -p crewforge < backend/sql/migration_permission.sql

cp backend/server/src/main/resources/application.example.yml \
   backend/server/src/main/resources/application.yml      # 填库口令、JWT 密钥、引擎目录
cd backend && ./mvnw spring-boot:run                      # :8080，接口文档 /doc.html

cd agent/engine && bun install                            # .env 见 .env.example（必填 DB_PASSWORD）
PROJECT_ID=1 RUNS_ROOT=../runs bun run projectRunner.ts 1 # 手动跑一局（产物落 agent/runs/）

cd frontend && npm install && npm run dev                 # :5173
```

打开 <http://localhost:5173>，初始管理员 **`admin` / `123456`**（登录后请立即修改）。

模型不必写进 `.env`：控制台「API 设置」把端点/Key/模型存进数据库，引擎 30s 热生效，可按角色分档。

## 验收与证据

开发先本地预演（编译 + 接口探测）→ 送检由独立验收器重跑出机器证据 → 交付门真的把项目起起来打断言：

| 交付报告 | 含义 | 能否宣称"已验证" |
|---|---|---|
| `ok` + `cleaned` | 真起过库与应用、断言全过 | ✅ |
| `skipped_unverified` | 没验证器 / 没 Docker / 无可验证对象 | ❌ 只能说"已生成" |
| `failed` | 编译、启动或契约断言失败 | ❌ |

```bash
cd agent/engine && bun x tsc --noEmit && bun test   # 引擎：类型检查 + 单测
cd frontend     && npm run build                    # 前端：类型检查 + 构建
cd backend      && ./mvnw test                      # 后端：接口与守卫测试
```

## 已知限制

- 前端是**轮询**（对话 4s、工作台 10s），没有 WebSocket/SSE；
- 验收器本地跑时用自己的终端问答，与后端审批通道尚未打通（规则真相仍只有一份）；
- "整棵产物树能构建"缺端到端物理证据；渲染检查依赖本机浏览器（起不起来会跳过并写理由）；
- 「混合模式下换阶段要确认」这条路径没跑过整机；
- Windows 上别直接改名带 pnpm `node_modules` 的目录（绝对路径 Junction 会全断，且只表现为"某个包找不到"）。

## 相关文档

[`agent/engine/README.md`](agent/engine/README.md)（引擎内部地图）·
[`agent/testAgent/README.md`](agent/testAgent/README.md)（验收器）·
[`frontend/DESIGN.md`](frontend/DESIGN.md)（界面设计语言）
