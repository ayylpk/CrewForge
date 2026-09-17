# 阶段 0 冻结场景 s4：轻量全栈小项目（待办清单 todo-lite）

> 本文件是**冻结输入**：写入 `sys_project.description` 后不许再改。
> 任何 LLM 提出的"需求改写/裁剪"都不生效。

## 目标

做一个单页面「待办清单」应用，前后端和数据库都要有。技术栈刻意选轻量的：
前端 Vue 3 + Vite（纯 JavaScript），后端 Node + Express，数据库 SQLite（单机文件库）。
不引入 TypeScript、UI 组件库、路由库、状态管理库、MySQL、Redis 或任何外部服务。

## 数据模型

待办 `todo`：`id`（数字自增主键）、`title`（字符串，必填）、`done`（布尔，缺省 false）、
`created_at`（时间）。只有一个实体，没有用户/权限/关联。

## 后端接口

放 `backend/` 目录，REST + JSON，前缀 `/api`，响应体直接就是数据对象本身（不要包一层 code/msg）：

1. `POST /api/todos`，请求体 `{"title":"..."}`
   → HTTP 201，响应体是新待办对象，`id` 是数字、`done` 是 false；
   `title` 缺失或为空字符串 → HTTP 400
2. `GET /api/todos`
   → HTTP 200，响应体是待办数组
3. `PATCH /api/todos/{id}`，请求体 `{"done":true}`
   → HTTP 200，响应体的 `done` 已更新；`id` 不存在 → HTTP 404
4. `DELETE /api/todos/{id}`
   → HTTP 200；**此后再 `GET /api/todos/{id}` 必须返回 HTTP 404**

数据库文件固定放 `backend/data/` 下（SQLite），目录不存在要自动创建。
依赖安装用 `npm install`，启动用 `npm start` 一键启动（`package.json` 里要有 start 脚本），
监听端口读环境变量 `PORT`。

## 前端页面

放 `frontend/` 目录，Vue 3 + Vite：`npm install` 后 `npm run build`（vite build）必须成功。
只有一个路由 `/`：

- 页面可见文案里包含「待办」二字
- 一个标题输入框和「添加」按钮，提交后调 `POST /api/todos` 并刷新列表
- 列表每条待办：勾选框切换完成状态（调 `PATCH /api/todos/{id}`）、删除按钮（调 `DELETE /api/todos/{id}`）
- 所有后端调用统一走 `/api` 前缀；API 暂时不可达时页面骨架（标题、输入框、按钮）仍要能渲染出来，不许白屏

## 验收（必须真实可执行）

1. 上面 4 个接口按顺序真实调用，全部符合预期（含"创建 201""删除后 404"）
2. 首屏渲染非白屏，页面文本包含「待办」，页面上有输入框

## 边界（本期不做）

- 不做登录、多用户、分页、通知；
- 不做服务端渲染；不做移动端适配；
- 不引入任何 ORM 之外的数据库迁移工具（用不用 ORM 由你定，轻量优先）。
