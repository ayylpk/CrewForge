# ============================================================
# Dockerfile.app —— CrewForge 应用容器（Java 后端 + agent 运行时）
#
#   为什么后端与 agent 运行时**放同一个容器**：
#     现有设计是「Java 后端 spawn `bun run projectRunner.ts {projectId}`」（一项目一进程），
#     同容器内直接 spawn 最省事、零跨容器编排；拆两个容器反而要处理 exec/共享工作区。
#
#   运行时必须带齐"生成项目要用的工具链"（这是本镜像最重的部分）：
#     JDK17 + Maven（编译生成的 Spring 项目）+ Node/Bun（构建生成的前端）
#     + Python（生成的 Python 项目）+ git + docker CLI（起容器做真实验收）
#
#   ⚠️ 未实测：本机 Docker daemon 未启动，此文件**未经构建验证**。首次部署前请先
#      docker build 跑一遍并修正版本号/包名（尤其是 NodeSource 与 bun 安装步骤）。
# ============================================================

# ---------- 阶段 1：构建后端可执行 jar ----------
FROM eclipse-temurin:17-jdk AS build
WORKDIR /src
# 先只拷 pom 以复用依赖层（改代码不必重下依赖）
COPY backed-CrewForge/pom.xml ./backed-CrewForge/
COPY backed-CrewForge/common/pom.xml ./backed-CrewForge/common/
COPY backed-CrewForge/pojo/pom.xml ./backed-CrewForge/pojo/
COPY backed-CrewForge/server/pom.xml ./backed-CrewForge/server/
COPY backed-CrewForge/mvnw backed-CrewForge/mvnw.cmd ./backed-CrewForge/
COPY backed-CrewForge/.mvn ./backed-CrewForge/.mvn
RUN cd backed-CrewForge && chmod +x mvnw && ./mvnw -B -q -DskipTests dependency:go-offline || true
# 再拷源码构建
COPY backed-CrewForge ./backed-CrewForge
RUN cd backed-CrewForge && ./mvnw -B -DskipTests package \
 && cp server/target/crewforge-server-*.jar /app.jar

# ---------- 阶段 2：运行时（JRE + 生成项目工具链 + agent 引擎）----------
FROM eclipse-temurin:17-jdk
ENV DEBIAN_FRONTEND=noninteractive

# 生成 Java 项目要编译 → 保留 JDK；其余工具按需装
RUN apt-get update && apt-get install -y --no-install-recommends \
      maven git curl unzip ca-certificates python3 python3-pip procps \
 && rm -rf /var/lib/apt/lists/*

# Node 22（构建生成的前端）
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# Bun（agent 运行时的本体）
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app
# 后端 jar
COPY --from=build /app.jar /app/app.jar
# agent 引擎（运行时目录结构必须保持：backed-CrewForge/mvnw 是生成项目的包装器兜底）
COPY agents-CrewForge /app/agents-CrewForge
COPY backed-CrewForge/mvnw backed-CrewForge/mvnw.cmd /app/backed-CrewForge/
COPY backed-CrewForge/.mvn /app/backed-CrewForge/.mvn
COPY sql /app/sql

# 产物树与工作区（挂卷持久化）
RUN mkdir -p /app/runs /app/runs/_verify
ENV RUNS_ROOT=/app/runs \
    CREWFORGE_MVNW=/app/backed-CrewForge/mvnw \
    PROJECT_ID="" \
    JAVA_BASE_URL=http://127.0.0.1:8080

EXPOSE 8080
# 健康检查：后端起来即算健康（生成项目的验收另有 run-report）
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8080/actuator/health || curl -fsS http://127.0.0.1:8080/ || exit 1

CMD ["java", "-jar", "/app/app.jar"]
