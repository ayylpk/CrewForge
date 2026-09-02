# CrewForge

> 一句话启动一支虚拟开发团队：**产品经理 → 架构师 → 前后端开发（双工位流水线）→ 测试 → 维护收敛**，Web 控制台全程可视、可介入。
>
> 定位：Agent 编排能力的面试演示工程——所有取舍按 演示效果 > 架构讲稿 > 代码质量 > 稳定性。

## 技术栈

| 端 | 目录 | 技术 |
|---|---|---|
| 前端 | `fronted-CrewForge/` | Vue 3 + Vite + TypeScript + Element Plus（藏青/午夜蓝赛博朋克风） |
| 后端 | `backed-CrewForge/` | Spring Boot 3 + MyBatis-Plus + MySQL 8 + JWT（`pojo/common/server` 三模块） |
| Agent 引擎 | `agents-CrewForge/` | Bun + TypeScript + LangChain.js / LangGraph.js |

## 架构

```
┌──────────────┐  REST + JWT   ┌──────────────────┐   spawn (bun run projectRunner.ts)   ┌─────────────────────┐
│ fronted :5173 │ ────────────→ │  backed :8080     │ ──────────────────────────────────→ │ agents-CrewForge     │
│ 看板/对话/设置 │ ←──────────── │ ProjectRun 进程管理│ ←────────────────────────────────── │ 消息版团队 + 拆分图    │
└──────────────┘  轮询 sys_task │ sys_* 全部落库     │   回调 java_base_url（缓存清理等）     │ Hub 进程内消息总线     │
                                └────────┬─────────┘                                     └──────────┬──────────┘
                                         │                     MySQL crewforge                       │
                                         └────────────────── sys_* ←────────────────────────────────┘
                                             sys_task=引擎与看板的桥（任务为原子）
```

**架构定性**：message-driven hierarchical pipeline multi-agent——workflow 骨架（门控/路由/计数/收敛全用代码），LLM 只在工位上产出内容，无运行时 supervisor。

**团队消息协议**（`Hub.ts`，协议消息只带 taskId，数据真相在 `sys_task`）：

```
manager → architect : phase_plan      architect → dev     : task
dev     → merger    : task_result     merger  → test      : pair_ready
test    → dev       : revision        test    → maintainer: task_passed
architect → maintainer: tasks_declared   maintainer → architect: phase_done(含失败清单)
architect → manager   : phase_request（阶段收尾，runner 代发下一阶段）
```

**数据模型**（MySQL `crewforge`，全表结构基线见 `backed-CrewForge/sql/schema.sql`）：
自定义 Agent 池 `sys_agent` + 节点声明 `sys_agent_node` + 连线 `sys_agent_edge` → 加入项目时**整表复制**为 `sys_project_agent` / `sys_project_agent_node`（复制非引用，项目间互不干扰）；产物文件 `sys_project_file`；任务桥 `sys_task`；确认门 `sys_confirm`；运行时配置 `sys_settings`（cc-switch 式：模型名/URL/key/回调基址——DB 连接参数在 `.env`，自举约束）。

## 快速起环境

```bash
# 1. 建库导基线（11 表，含默认配置行）
mysql -u root -p -e "CREATE DATABASE crewforge DEFAULT CHARSET utf8mb4"
mysql --default-character-set=utf8mb4 -u root -p crewforge < backed-CrewForge/sql/schema.sql

# 2. 后端（先改 application.yml 的 DB 账号密码）
cd backed-CrewForge && ./mvnw spring-boot:run        # :8080

# 3. 引擎（先建 .env：DB_PASSWORD=*** DEEPSEEK_API_KEY=***
cd agents-CrewForge && bun install
#    手动驱动（Java 未点开工时的调试入口）：
PROJECT_ID=1 AUTO_CONFIRM=1 bun run projectRunner.ts 1

# 4. 前端
cd fronted-CrewForge && npm install && npm run dev    # :5173
```

## 当前状态（2026-09 修复路线，详见《CrewForge-全链接修复计划》）

- [x] 阶段 0 地基：schema 基线入库 / 三张新表 / 死代码清零 / 桌面端封存
- [ ] 阶段 1 sys_task 桥：看板从假卡片换成任务真数据 ← **进行中**
- [ ] 阶段 2 点火 + 配置层：Web「开工」按钮、cc-switch 设置页、按阶段起进程
- [ ] 阶段 3 确认门回路 / 阶段 4 冒烟验证闭环（到这里 = 面试演示可用）
- [ ] 阶段 5 PM 在线化热更新 / 阶段 6 加分项

**已知边界**（诚实清单，熔断降级后在此记录）：
- 前端执行视图仍在播 mock 时间线（阶段 1 撤除）；设置页存 localStorage（阶段 2 接真）
- 测试工位纸面审、不执行代码（阶段 4 冒烟补）
- 确认门依赖 stdin/自动定稿，Web 问答回路未通（阶段 3）
- `DeskTop-CrewForge` 桌面端为前端暴力拷贝，已封存于仓库外（`F:/code/_archive/`，真做时壳引用 web dist）

## 说明

- `_legacy-agents/`：第一代引擎归档，仅留档对照，不参与构建。
- 进程模型：**按阶段起进程**——引擎进程跑完一个阶段即退出，Java 对账（`sys_project.status=executing` 且无活进程 → 重拉下一阶段），崩溃恢复由 `sys_task` 状态机天然给出。
