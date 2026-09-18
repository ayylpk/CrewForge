# CrewForge 技术资产与模板扩展设计

## 目标

扩展 `agents-CrewForge/developerAgent/assets`，增加一批常用后端、前端、数据库、中间件和基础设施资产。新增内容必须遵循现有资产协议，能够被架构师渐进披露、被 Developer 按 manifest 渲染，并通过静态目录完整性检查。

本批次采用独立可组合资产，不创建把多个框架绑定在一起的“大一统模板”。业务代码仍由 Developer 根据任务生成；资产只提供最小可运行骨架、依赖片段、配置约束和验证命令。

## 资产清单

### 独立技术栈

| kind | id | 作用 |
| --- | --- | --- |
| backend | `nestjs` | NestJS + TypeScript + Node.js REST 服务骨架 |
| backend | `fastapi` | FastAPI + Python REST 服务骨架 |
| frontend | `react-vite` | React + TypeScript + Vite 单页前端骨架 |
| database | `postgresql` | PostgreSQL 关系数据库、Compose 与迁移模板 |
| database | `redis` | Redis 缓存/队列基础配置与 Compose 模板 |

### 可组合中间件

中间件使用独立目录和 `kind: "middleware"`，通过 `requires` 声明宿主能力，通过 package fragment、配置片段或源码 snippet 接入，不复制宿主框架模板。

| id | 宿主 | 提供能力 |
| --- | --- | --- |
| `jwt-auth` | Node/Nest/Express/FastAPI | JWT 鉴权配置、密钥变量和认证 middleware 示例 |
| `cors` | Node/Nest/Express/FastAPI | CORS 配置片段和允许来源变量 |
| `validation-zod` | Node/Nest/Express/React | Zod schema/请求校验依赖片段 |
| `openapi` | Node/Nest/FastAPI | OpenAPI 文档配置与健康检查说明 |
| `logging-pino` | Node/Nest/Express | Pino 结构化日志配置片段 |

### 基础设施模板

| kind | id | 作用 |
| --- | --- | --- |
| infrastructure | `docker-compose` | 应用、数据库和缓存的本地编排模板 |
| infrastructure | `env-config` | `.env.example`、变量约束和运行时配置说明 |

## 目录和 manifest 约定

独立技术栈沿用现有布局：

```text
assets/<kind>/<id>/
  summary.md
  manifest.json
  constraints.md
  template/...
  integration/...        # 仅在需要宿主集成时存在
```

中间件和基础设施允许使用 `template/`、`integration/` 或 `snippets/`，但每个 manifest 必须至少包含：

- `schemaVersion: "crewforge.asset/v1"`
- 唯一 `id`、`kind`、固定 `version`
- `summaryFile`、`constraintsFile`
- 非空 `provides`、数组类型的 `requires` 与 `conflicts`
- 变量定义（涉及密钥、端口或来源时必须声明）
- 至少一个可验证文件，以及至少一个 validation command 或静态 validation 规则

模板变量继续使用 `{{VARIABLE}}`，不允许原样交付到生成项目。所有模板必须是 ASCII 文本，除非现有项目已经明确使用其他编码。

## 组合规则

1. `catalog.json` 注册所有新增资产，摘要保持不超过 20 行。
2. 独立技术栈只声明自身直接提供的能力；数据库和中间件不隐式安装后端框架。
3. `requires` 表达能力依赖，例如 `jwt-auth` 需要 `backend.http` 或对应宿主能力；无法满足时由资产校验报告缺失，不静默替换资产。
4. `conflicts` 用于互斥实现，例如不同日志适配器或同类 UI/鉴权实现；同一类别可并存的资产不得伪造冲突。
5. 现有 `matchStackAssets` 只匹配 frontend/backend/database 槽位，本批次不改变其默认三槽位语义；中间件和基础设施通过 manifest/集成阶段消费，不冒充三类主技术栈。
6. 新增资产不得引入真实 `node_modules`、Python 虚拟环境、构建产物或凭据文件。

## 最小模板边界

- `nestjs`：`package.json`、TypeScript 配置、应用入口、健康路由和模块注册点。
- `fastapi`：`pyproject.toml`、应用入口、健康路由、配置模块和最小测试命令。
- `react-vite`：`package.json`、Vite/TypeScript 配置、入口、`App.tsx` 和路由扩展点。
- `postgresql`：Compose、环境变量示例、Flyway-compatible baseline SQL 和连接参数片段。
- `redis`：Compose、环境变量示例、连接配置片段和健康检查说明。
- 中间件：只提供安装片段、配置 snippet、变量和适配说明，不写死业务路由、用户模型或领域 schema。
- `docker-compose` / `env-config`：只提供可组合的服务和变量模板，不覆盖宿主已有文件；目标文件使用明确 extension point。

## 验证策略

扩展 `agents-CrewForge/developerAgent/tests/assets.test.ts`，覆盖：

1. catalog 中所有新增 id 唯一、path 存在且不越出 assets 根目录。
2. 每个新增资产的摘要行数、manifest schema、kind/id、一致的 source 文件和变量声明。
3. `requires`/`provides` 的引用格式有效；冲突项对称且不与自身冲突。
4. 模板不含未声明的 `{{...}}` 变量，不包含 `node_modules`、密钥样例或构建产物。
5. 独立技术栈的验证命令存在；中间件和基础设施至少有静态验证规则或片段完整性检查。
6. 既有六个资产和 UI 互斥测试继续通过，避免新增 catalog 项破坏原有选择逻辑。

实现完成后运行资产测试和 TypeScript 类型检查；若某个资产需要真实外部运行时（Python、PostgreSQL、Redis），测试只验证模板契约和命令声明，不在单元测试中启动外部服务。

## 非目标

- 本批次不改造架构师的三槽位 StackProfile schema。
- 不为每个框架实现完整 ORM、鉴权业务、消息队列或生产部署方案。
- 不把所有中间件自动注入所有后端；组合关系必须由 manifest 明确声明。
- 不修改与资产任务无关的现有工作区改动。
