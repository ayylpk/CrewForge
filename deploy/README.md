# CrewForge 部署说明

> ## ⚠️ 未实测声明
> 本目录下的 Dockerfile / compose / nginx 配置是**按当前代码结构写的**，但**没有跑过一次真机部署**——
> 因为开发机上 Docker daemon 未启动（`docker version` 报 `cannot connect to the docker API`）。
> 首次部署请按下面的"检查清单"逐项确认，遇到问题先把报错原文留下来（别改配置试运气）。

---

## 一、拓扑

```
                 ┌──────────────┐
  浏览器 ──────▶ │ web (nginx)  │  80
                 └──────┬───────┘
                        │ /api 反代（前端用相对路径 /api/...）
                 ┌──────▼───────────────────────────────┐
                 │ app                                  │
                 │  · Java 后端（Spring Boot, :8080）    │
                 │  · bun agent 运行时（Java spawn 它）  │
                 │  · 生成项目工具链（JDK/Maven/Node/Bun）│
                 └───┬──────────────────┬───────────────┘
                     │                  │
              ┌──────▼─────┐     ┌──────▼─────┐
              │ mysql:8.0  │     │ redis:7    │
              └────────────┘     └────────────┘
```

**为什么后端与 agent 运行时同容器**：现有设计是 Java `spawn("bun", ["run","projectRunner.ts", projectId])`
（一项目一进程）。同容器直接 spawn，零跨容器编排。

---

## 二、前置检查清单（三分钟，别跳）

| 检查 | 命令 | 期望 |
|---|---|---|
| Docker 装了且 **daemon 在跑** | `docker version` | 能看到 `Server:` 段；只看到 `Client:` = daemon 没起 |
| Compose 可用 | `docker compose version` | 输出 v2.x |
| 磁盘 | `df -h` / Windows 看盘 | **≥ 20G**（工具链镜像 + Maven 依赖 + 生成项目） |
| 内存 | 至少 4G 给 app | 否则生成项目构建会被 OOM 杀 |
| 端口 | `80` 与 `8080` 未被占用 | 占用就改 `.env` 的 `WEB_PORT` |

---

## 三、部署三步

```bash
cd deploy
cp .env.example .env          # 填 MYSQL_* 与 DEEPSEEK_API_KEY
docker compose up -d --build  # 首次构建约 10~25 分钟（工具链镜像很重）
docker compose ps             # 四个服务都应是 healthy / running
docker compose logs -f app    # 看后端起来没有
```

打开 `http://<服务器IP>/` 即前端站点。

---

## 四、怎么算"部署成功"（验收，不是感觉）

1. 前端能打开、能登录/建项目（`web` → `/api` 通）。
2. 提交一个需求，**跑到结束**。
3. 看产物与证据（两种方式）：
   ```bash
   docker compose exec app ls /app/runs/p<项目ID>            # 生成的项目
   docker compose exec app cat /app/runs/p<项目ID>/_verify/run-report.md   # 交付关证据
   ```
4. 结论分三种，**必须区分清楚**：

| run-report 结论 | 含义 | 能不能对外说"已验证" |
|---|---|---|
| `ok` + `cleaned` | 真起过库与应用、契约断言全过 | ✅ 可以 |
| `skipped_unverified` | 没验证器/没 Docker/无可验证对象 | ❌ **不可以**（只能说"已生成"） |
| `failed`（compile/boot/contract） | 验证没过 → 项目状态落 `failed` | ❌ 不可以 |

---

## 五、两种运行模式（按你的场景选）

**A. 真验收模式（推荐给我自己用/可信场景）**
```bash
# deploy/.env
CREWFORGE_ALLOW_DOCKER=1
# 同时打开 docker-compose.yml 里 app 的 docker.sock 挂载（默认被注释）
```
好处：生成的项目会**真的**起 MySQL 容器 + 起服务 + 打接口，交付关能给出 `ok`。
代价：见下面的安全边界。

**B. 未验证模式（默认，托管给外部用户）**
```bash
CREWFORGE_ALLOW_DOCKER=0
```
好处：容器无法碰宿主；生成项目只做静态校验。
代价：交付关返回 `skipped_unverified`，**对外不得宣称已验证**——这是刻意的诚实降级。

---

## 六、安全边界（这段请认真看）

1. **`/var/run/docker.sock` 挂进容器 ≈ 把宿主 root 交给容器。** 只要 `CREWFORGE_ALLOW_DOCKER=1`，
   用户提交的需求最终会变成"在你这台机器上跑容器"。**给外部用户用就别开**，或者：
   - 用**独立 worker 主机**（坏了不心疼，与主站隔离）；
   - 或用 DinD（`docker:dind`）+ 资源限额 + 禁外网（只留镜像仓库白名单）。
2. **`app` 的资源限额不是可选项**：生成项目会跑 Maven/npm 构建，`APP_MEM_LIMIT` / `APP_CPU_LIMIT` 别删。
3. **LLM 密钥在服务端**：一个用户跑十个项目 = 你的账单。上线前务必在设置里配**月预算上限**（当前代码支持按档位/并发限流，预算熔断已实现，但需要你配数值）。
4. **`runs-data` 卷会越来越大**：生成项目 + Maven 缓存都在里面，记得加清理策略（归档旧的 `p*` 目录）。

---

## 七、常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| `Cannot connect to the Docker daemon` | daemon 没起 | 启动 Docker Desktop / `systemctl start docker` |
| app 反复重启 | 连不上 mysql/redis | `docker compose logs app`；确认 healthcheck 通过再启动 app（compose 已配 `condition: service_healthy`） |
| 构建卡在 Maven 下载 | 首次拉依赖 | 正常，10~20 分钟；国内可换镜像源 |
| 生成项目验收总失败在 `env_error` | 容器内无 Docker 或依赖拉不到 | 确认 `CREWFORGE_ALLOW_DOCKER` 与 docker.sock；或接受"未验证"模式 |
| 前端能开但接口 404 | nginx 反代没生效 | 检查 `nginx.conf` 的 `location /api/` 与 `proxy_pass http://app:8080` |
| 前端构建失败 | Node 版本过低 | `Dockerfile.web` 用 node:22；生成项目的前端也要求 Node ≥ 18 |

---

## 八、首次部署后请回报这几项（我要用来改配置）

1. `docker compose ps` 的四个服务状态；
2. `docker compose logs app | tail -50` 有没有报错；
3. 一次完整跑通的结果：**run-report 的结论 + 耗时 + token 成本**；
4. 镜像大小（`docker images`）与构建耗时——太重的话我改成按需安装工具链。

有了这四项，我就能把"未实测"这条去掉，并把 `.env` 默认值与资源限额调到实测值。
