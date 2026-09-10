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
manager.ts      产品经理（图版多轮对话 → clarified_req/dev_plan 落库；T5：定稿硬绑 UI 三问决策）
architect.ts    架构师（拆分图：T4 功能竖切 buildExecTasks → T2 契约发布 publishContracts → 下发）
backend/frontendEngineer.ts  开发工位（伪代码/设计稿→逐文件代码→T1 编译闸门自修环→写盘 runs/pX）
testEngineer.ts 测试（T6：机械三查[编译/色值/渲染]+六项硬清单纸审+假通过机器改判，纸面审旧口径作废）
merger.ts       接口对配对（双工位汇流）｜ maintainer.ts 阶段收敛（失败清单/放弃）
task.ts         sys_task CRUD（任务为原子；阶段 1 起成为主干）
runEnv.ts       文件沙箱（runs/pX 房间 + 路径逃逸防护）
Node.ts         DB 读取层（成员/节点/边/落库钩子）｜ models.ts 厂商注册表 + T3 角色分档(resolveRoleTier)
checkers.ts     ★ T1 编译闸门：esbuild/@vue/compiler-sfc/py_compile/JSON + import 存在性&导出名核验
contracts.ts    ★ T2 全局契约：CONTRACTS.md 生成（代码拼骨架+LLM 登记页面/模块归属）+ 工位头部注入
renderGate.ts   ★ T6 渲染审：vite dev 惰性起服 + headless Edge dump-dom/截图（_shots/）+ 白屏判定
concurrency.ts  ★ T7a 令牌闸：队列无上限、token 限在制（四阶段闸各 5 + 端点总闸 6，设置页热调，落盘/失败才归还）
fileTools.ts    ★ T7b 工位文件工具：read/write/edit 工具循环（工具内过闸+落盘+文件锁；tool_mode 默认关，异常自动退老路）
llm.ts / tools.ts / common.ts  模型调用封装（含端点总闸挂点）/ 工具声明 / 类型、写盘与 T4 sliceGuard
settings.ts     sys_settings 30s 缓存（cc-switch 配置层引擎半边）
```

## 冒烟套件（确定性层，零 LLM 零 DB 为主，commit 前常备跑）

| 脚本 | 覆盖面 | 基线 |
|---|---|---|
| `compile-gate-smoke.ts` | T1 坏码必拒/好码零误杀/自修环三态/批校验 | 28 绿 |
| `contracts-smoke.ts` | T2 契约骨架/降级占位/旁路 | 19 绿 |
| `pm-ui-smoke.ts` | T5 ui 机读核验/解析/契约标注 | 17 绿 |
| `role-tier-smoke.ts` | T3 档位解析/旁路底线（不配=逐字节不变） | 20 绿 |
| `render-smoke.ts` | T6 白屏判定/色扫/假通过改判/skip 旁路 | 16 绿 |
| `t4-smoke.ts` | T4 竖切 schema/buildExecTasks 狗考/护栏 | 25 绿 |
| `t7-smoke.ts` | T7a 令牌闸：在制≤限额/异常归还/排队不吃超时/clamp | 9 绿 |
| `t7b-smoke.ts` | T7b 文件工具：五工具语义/文件锁/循环机械终止 | 21 绿 |
| `message-protocol-smoke.ts` | Hub 消息 schema 与阶段边界拒绝 | 10 绿 |
| `artifact-validation-smoke.ts` | 任务产物、工作区基线与证据结构 | 6 绿 |
| `core-team-smoke.ts` | 固定核心角色与内置兜底 | 6 绿 |
| `bridge-smoke.ts` | 阶段 1 任务桥（旁路设计，离线可跑） | 11 绿 |

```bash
for s in compile-gate-smoke contracts-smoke pm-ui-smoke role-tier-smoke render-smoke t4-smoke t7-smoke t7b-smoke bridge-smoke; do bun run $s.ts || break; done
```

## 本地跑

```bash
bun install            # 依赖 bun.lock
bun x tsc --noEmit     # 类型检查（应保持零输出）
```

仓库根目录执行 `powershell -ExecutionPolicy Bypass -File scripts/verify.ps1` 可一次完成全部零 LLM smoke、前端构建、后端测试和 Git diff 检查；快速回归可加 `-SkipBuilds`。

`.env`（bun 自动加载）：`DB_PASSWORD`（库=crewforge，连接参数见 Node.ts/task.ts 池）、`DEEPSEEK_API_KEY`。
