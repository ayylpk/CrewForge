# 阶段 0 冻结场景 s1：最小 CRUD（便签管理）

> 本文件是**冻结输入**：写入 `sys_project.description` 后不许再改。
> 任何 LLM 提出的"需求改写/裁剪"都不生效——baseline 只回答"当前系统拿这份需求能跑出什么"。

## 目标

做一个单页面「便签管理」应用。前端 Vue 3 + Vite，后端 Spring Boot 3 + MySQL 8。

## 数据模型

便签 `note`：`id`（自增主键）、`title`（字符串，必填）、`content`（字符串）、`created_at`（时间）。

## 后端接口

前缀 `/api`，统一响应体 `{"code":200,"msg":"ok","data":...}`：

1. `POST /api/notes`，请求体 `{"title":"...","content":"..."}`
   → HTTP 200，`data` 为新便签对象，`data.id` 是数字
2. `GET /api/notes`
   → HTTP 200，`data` 是便签数组
3. `GET /api/notes/{id}`
   → HTTP 200，`data.title` 是字符串
4. `PUT /api/notes/{id}`，请求体 `{"title":"...","content":"..."}`
   → HTTP 200
5. `DELETE /api/notes/{id}`
   → HTTP 200；**此后再 `GET /api/notes/{id}` 必须返回 HTTP 404**

## 前端页面

- 只有一个路由 `/`
- 页面可见文案里包含「便签」
- 页面上有：便签列表、新增表单（标题输入框 + 内容输入框 + 提交按钮）、每条便签的删除按钮
- 所有后端调用统一走 `/api` 前缀

## 构建与启动

- 前端放 `frontend/` 目录：`npm install` 后 `npm run build`（vite build）必须成功
- 后端放 `backend/` 目录：Maven（`mvnw`）打包必须成功，`java -jar` 启动后监听 8080
- 后端连库用环境变量 `SPRING_DATASOURCE_URL/USERNAME/PASSWORD`，不许把库地址写死在代码里

## 验收（必须真实可执行）

1. 上面 5 个接口按顺序真实调用，全部符合预期（含"删除后 404"）
2. 首屏渲染非白屏，页面文本包含「便签」
