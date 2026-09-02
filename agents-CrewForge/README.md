# agents-CrewForge —— Agent 引擎

TypeScript + Bun + LangChain/LangGraph 的消息版开发团队引擎。**总架构与跑法见仓库根 [README.md](../README.md)**，此处只记引擎内部地图。

## 入口

| 文件 | 用途 |
|---|---|
| `projectRunner.ts` | ★ 主入口：建团队 → PM 对话 → 逐阶段下发架构师（Java `ProjectRun` spawn 的就是它，也可手动 `bun run projectRunner.ts {projectId}`） |

## 引擎地图

```
Hub.ts          消息总线（TransferStation：注册/路由/负载）+ 角色枚举
BaseAgent.ts    消息循环骨架（on(type, handler) 注册协议处理器）
GraphFactory.ts 声明式拼图（DB 的 sys_agent_node/edge → LangGraph）+ Questioner（CLI/HTTP）
manager.ts      产品经理（图版多轮对话 → clarified_req/dev_plan 落库）
architect.ts    架构师（收 phase_plan → 拆分 ExecTask → 下发双工位）
backend/frontendEngineer.ts  开发工位（伪代码→代码→写盘 runs/pX）
testEngineer.ts 契约判定（⚠️ 纸面审——冒烟物理证据在阶段 4 补）
merger.ts       接口对配对（双工位汇流）｜ maintainer.ts 阶段收敛（失败清单/放弃）
task.ts         sys_task CRUD（任务为原子；阶段 1 起成为主干）
runEnv.ts       文件沙箱（runs/pX 房间 + 路径逃逸防护）
Node.ts         DB 读取层（成员/节点/边/落库钩子）｜ models.ts 厂商注册表
llm.ts / tools.ts / common.ts  模型调用封装 / 工具声明 / 类型与写盘
```

## 本地跑

```bash
bun install            # 依赖 bun.lock
bun x tsc --noEmit     # 类型检查（应保持零输出）
```

`.env`（bun 自动加载）：`DB_PASSWORD`（库=crewforge，连接参数见 Node.ts/task.ts 池）、`DEEPSEEK_API_KEY`。
