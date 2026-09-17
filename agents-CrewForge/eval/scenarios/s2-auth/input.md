# 阶段 0 冻结场景 s2：登录 / 鉴权（JWT）

> 本文件是**冻结输入**：写入 `sys_project.description` 后不许再改。

## 目标

前端 Vue 3 + Vite，后端 Spring Boot 3 + MySQL 8，实现"登录 → 带 token 访问受保护接口"的闭环。

## 数据模型

用户 `user`：`id`、`username`（唯一）、`password`（BCrypt 哈希存储）。

后端启动时必须保证存在账号 `username=admin` / `password=123456`（不存在则插入，存在则不动）。

## 后端接口

前缀 `/api`，统一响应体 `{"code":200,"msg":"ok","data":...}`：

1. `POST /api/auth/login`，请求体 `{"username":"admin","password":"123456"}`
   → HTTP 200，`data.token` 是字符串（JWT）
   → 用户名或密码错误时返回 **HTTP 401**
2. `GET /api/auth/me`，请求头 `Authorization: Bearer <token>`
   → HTTP 200，`data.username` 等于 `"admin"`
   → 缺失或非法 token 时返回 **HTTP 401**

## 前端页面

- 路由 `/login`：用户名输入框、密码输入框、文案包含「登录」的按钮
- 路由 `/`：受保护页面，登录后可见，页面上显示当前用户名
- 未登录直接访问 `/` 时跳转到 `/login`

## 构建与启动

- 前端放 `frontend/`：`npm install` 后 `npm run build` 必须成功
- 后端放 `backend/`：Maven 打包成功，`java -jar` 启动后监听 8080
- 后端连库用环境变量 `SPRING_DATASOURCE_URL/USERNAME/PASSWORD`

## 验收（必须真实可执行）

1. `POST /api/auth/login`（admin/123456）→ 200 且 `data.token` 非空
2. 带该 token 请求 `GET /api/auth/me` → 200 且 `data.username == "admin"`
3. 不带 token 请求 `GET /api/auth/me` → **HTTP 401**
4. `POST /api/auth/login`（admin/错误密码）→ **HTTP 401**
5. `/login` 页面渲染非白屏，且存在 `input` 元素
