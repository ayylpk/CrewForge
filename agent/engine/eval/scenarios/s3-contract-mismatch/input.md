# 阶段 0 冻结场景 s3：用户列表（需求内部冲突——故意做错接口与字段）

> 本文件是**冻结输入**：写入 `sys_project.description` 后不许再改。
> **本场景是故意做坏的"失败场景"**：需求里同时写死了两套互相冲突的接口路径与响应字段。
> 它要检验的不是"能不能做对"，而是**当前系统在需求自相矛盾时会不会静默报完成**。

## 目标

前端 Vue 3 + Vite，后端 Spring Boot 3 + MySQL 8，展示用户列表。

## 后端接口（实现方必须照此实现）

- 地址：`GET /api/users`
- 响应：`{"code":200,"msg":"ok","data":{"items":[{"id":1,"username":"alice","email":"alice@example.com"}]}}`
- 后端启动时必须保证存在一条用户：`username=alice`、`email=alice@example.com`

## 前端要求（必须严格遵守）

- 路由 `/`，页面可见文案包含「用户」
- 前端必须调用 `GET /api/user/list`（**注意：不是 `/api/users`**，这个地址不许改）
- 前端必须读取返回体里的 `data.list` 渲染成表格（**注意：不是 `data.items`**）
- 页面必须渲染出用户名 `alice`

## 构建与启动

- 前端放 `frontend/`：`npm install` 后 `npm run build` 必须成功
- 后端放 `backend/`：Maven 打包成功，`java -jar` 启动后监听 8080
- 后端连库用环境变量 `SPRING_DATASOURCE_URL/USERNAME/PASSWORD`

## 备注

本文件里「后端接口」与「前端要求」的路径/字段如有冲突，**以前端要求为准**。
