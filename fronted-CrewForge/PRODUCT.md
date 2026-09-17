# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- 主用户：项目作者本人（独立开发者），自己是整条 AI 软件开发流水线的操作员：提需求、确认方案、盯执行、验收产出。
- 次用户（真实存在）：外部观看者——求职演示/项目展示场景，界面必须让陌生人第一次打开就能看懂"需求→架构→团队执行→产出"的完整链路（2026-09-17 用户确认"自用为主 + 对外展示"）。

## Product Purpose

fronted-CrewForge 是 CrewForge（AI 多 Agent 软件工厂）的 Web 控制台。6 个活跃页面构成一条操作动线：登录 → 项目列表（含运行时设置）→ 需求对话（AI 项目经理澄清功能清单）→ 架构师工作台（技术选型 + 分阶段开发计划 + 目录树）→ 项目概览（开工/停止/下载 zip）→ 执行面板（任务看板 + 文件树 + Monaco 代码 + 执行日志 + 人工确认门）。成功 = 操作者随时知道团队跑到哪一步、每个 Agent 在产出什么，并能介入（确认/重跑/停止）。

## Positioning

它展示的不是"一个聊天机器人"，而是一支有分工的工程团队：6 个角色（项目经理/架构师/后端/前端/测试/维护）、阶段化计划、任务四列看板、三档人工确认门（全绿灯/混合/手动）。流水线全程可观测、可打断、可重跑单个任务。

## Operating Context

- 后端 Spring Boot（默认 http://localhost:8080，VITE_API_BASE 可覆盖），REST + 前端 10s 轮询；全应用无 SSE/WebSocket。
- 登录返回 token 存 localStorage（cf_token），以 Authorization 头裸值发送（无 Bearer 前缀）。
- 中文优先界面；运行在桌面浏览器为主，需要响应式收敛。
- 执行面板是"工作台"型界面：侧栏/日志区可拖拽调宽，文件标签页 + Monaco 编辑器。

## Capabilities and Constraints

- 6 活跃页重写；3 个封存页（TeamView / AgentRepositoryView / AgentFormView）源码不动，路由守卫继续以弹窗拦截（2026-09-17 用户拍板）。
- 硬约束：路由路径与 API 契约不变（后端不动）。后端 JSON 字符串字段：businessModules / techStack / devPlan / dirTree / optionsJson；devPlan 存在两种历史形态（数组 或 {phases}），解析必须保持宽容。
- confirmMode：前端字符串 green/mixed/manual ↔ 线上 0/1/2，映射在 api/project.ts。
- 轮询生命周期：execution 页 10s 轮询 tasks+files+confirms；detail 页 10s 轮询 project+runStatus；均 onMounted 起、onBeforeUnmount 清。
- Element Plus 整体移除（2026-09-17 用户拍板）：toast/确认框/树全部自制；Monaco 编辑器保留（重键 :key 只能是 path，见旧代码 bug F4 教训）。
- PM/架构师对话与执行面板内聊天目前是本地 mock（无后端调用），重写保持该行为不夸大。
- 未决：聊天是否接真 LLM（本次不做）；7 个 Agent 头像里 backend/frontend/tester/maintainer 四张当前只存在于 constants 未渲染。

## Brand Commitments

- 产品名 CrewForge 固定不动（2026-09-17 用户确认）。
- logo 可随新视觉方向重画（用户授权），现有 logo-crewforge.png 不视为锁定资产。
- 旧"藏青工程控制室"视觉口径自本次重设计起作废，仅作证据与反参照；新方向由 impeccable 方向轮确定并写入 DESIGN.md。

## Evidence on Hand

- 现有图片资产：bg-login.png、logo-crewforge.png、agent-{manager,architect,backend,frontend,tester,maintainer}.png；hero.png / banner-agents.png 为闲置/仅封存页引用。
- 真实数据全部来自后端 DB（项目、任务、文件、设置）；UI 内不得出现虚构的测试数据、客户、评分或性能声明。
- docs/superpowers/plans/2026-09-10-frontend-control-room-redesign.md：其中仍成立的产品级原则——颜色只服务状态（运行/通过/失败/等待确认）、图标必须有标签与键盘焦点、破坏性操作与主操作分离。

## Product Principles

1. 状态优先：颜色与动效只表达执行状态与变化，不做装饰。
2. 流水线是骨架：每个版面回答"现在到哪、接下来是什么、谁在动手"。
3. 外人看得懂：陌生观看者第一眼能重建整条工作流。
4. 文字即界面：按钮动词=实际动作名，错误直说原因与出路，不卖萌不模糊。
5. 大胆只用在一处：其余保持安静、克制、秩序。

## Accessibility & Inclusion

- 中文文案优先，字体栈含 PingFang SC / Microsoft YaHei / Noto Sans SC。
- 键盘焦点可见、prefers-reduced-motion  respected（旧全局已实现，重写保留）。
- 正文对比度 WCAG AA；暗色主题下重点校验状态色可读性。
