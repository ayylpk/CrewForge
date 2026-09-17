// ============================================================
// springVueMysql.ts —— 引擎拥有的单栈骨架直出（Vue 3 + Vite + Element Plus / Spring Boot 3 + MyBatis-Plus / MySQL 8）
//
//   为什么"骨架必须由引擎写死"（是病根，不是偏好）：
//     · runs/p9 全树没有 main.ts / App.vue —— 入口被当成普通文件交给模型自由发挥，产物根本跑不起来；
//     · 同一项目里出现四套互斥目录约定（app.py / backend/app.py / src/... / web/...）—— 路径无 owner 即漂移；
//     · application.yml 里写死 jdbc 地址与 root 口令 —— 生成物换台机器就静默连错库（甚至连上生产库）。
//   本文件把这三个病根一次性钉死：**路径写死、内容写死、数据库配置只能来自环境变量**。
//
//   铁律（改动前先读）：
//     ① 骨架直出：路径与内容全部在本文件里写死（只允许参数插值），renderSkeleton 的返回值即最终落盘内容，
//        绝不由 LLM 决定。
//     ② datasource 的 url/username/password 只允许 ${SPRING_DATASOURCE_*}，**不写 `:默认值` 回落**：
//        骨架里出现一个字面量地址/账号/口令 = 生成项目在别人机器上连错库。
//     ③ schema.sql 必须由后端启动时真实执行：spring.sql.init.mode=always + schema-locations=classpath:schema.sql。
//        DDL 原文由架构师产出，但 CREATE DATABASE / USE 必须剥掉（库名/连接目标由连接串决定，不能写在 schema 里）
//        → 见 normalizeDdl（幂等，可反复调用）。
//     ④ Java 基础包固定 com.crewforge：Application.java 必须就在 com.crewforge，否则扫不到 com.crewforge.* 下的 Bean。
//     ⑤ 不引入 Lombok（生成项目不带编译期注解处理器）。
//     ⑥ 业务响应成功码 200 是**冻结需求**规定的承载值（见 engine/ir/scenarioSpec.ts：code=200 是需求抠出来的，
//        历史上引擎写死 1 才导致"后端按需求返回 200 反被判失败"），所以前端 request 封装里把它写成常量并注明来源。
// ============================================================

/** 骨架文件：owner 恒为 engine（写盘纪律只认引擎拥有件） */
export interface SkeletonFile {
    path: string;
    content: string;
    owner: "engine";
}

/** 契约登记的页面路由；component 形如 "views/NoteList.vue"（相对 frontend/src） */
export interface SkeletonRoute {
    path: string;
    component: string;
    name?: string;
}

export interface SkeletonOpts {
    /** 如 "note-app"：用于 spring.application.name / package.json name / pom artifactId */
    appName: string;
    /** index.html 的 <title> */
    title: string;
    /** 架构师产出的 DDL 原文（可能含 CREATE DATABASE / USE，需要归一化） */
    ddl?: string | null;
    /** 契约登记的页面路由 */
    routes: SkeletonRoute[];
    /** 主页面路由；见下面"路由铁律" */
    primaryRoute?: string;
    /** 前端请求封装路径，默认 "frontend/src/utils/request.ts" */
    requestPath?: string;
}

// ---------- 路径常量（归一化：全小写 + 正斜杠） ----------

export const DEFAULT_REQUEST_PATH = "frontend/src/utils/request.ts";

export const APPLICATION_PATH = "backend/src/main/java/com/crewforge/Application.java";

/**
 * 骨架固定产出的路径（规格里写作"12 个路径"，逐条列出的实为 13 条：前端 9 + 后端 4）。
 * renderSkeleton 必须**恰好**返回这些路径（requestPath 被显式覆盖时，只替换其中的请求封装那一条）。
 */
export const SKELETON_PATHS: readonly string[] = [
    "frontend/index.html",
    "frontend/package.json",
    "frontend/vite.config.ts",
    "frontend/tsconfig.json",
    "frontend/src/main.ts",
    "frontend/src/App.vue",
    "frontend/src/style.css",
    "frontend/src/router/index.ts",
    DEFAULT_REQUEST_PATH,
    "backend/pom.xml",
    APPLICATION_PATH,
    "backend/src/main/resources/application.yml",
    "backend/src/main/resources/schema.sql",
];

/**
 * 引擎拥有件路径表（归一化小写 + 正斜杠）：任何任务都不得产出或修改这些文件。
 * = 骨架 13 条 + 历史引擎件（Express 时代遗留 backend/src/app.js；frontend/src/style.css 已在上表内）。
 */
export const ENGINE_OWNED_PATHS: string[] = [
    ...SKELETON_PATHS,
    "backend/src/app.js",
];

// ============================================================
// ① DDL 归一化（幂等）
// ============================================================

/** 空 DDL 的占位说明（schema.sql 仍必须存在：spring.sql.init.mode=always 会真的执行它） */
const EMPTY_SCHEMA_COMMENT = "-- 本阶段无表结构：架构师未产出 DDL，schema.sql 为空占位（启动时仍会执行本文件）";

/** 语句首关键字区之前允许出现的前导噪音：空白、-- 行注释、# 行注释、块注释 */
const LEADING_TRIVIA = /^(?:\s+|--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)*/;

const CREATE_DATABASE_RE = /^CREATE\s+DATABASE\b/i;
const USE_RE = /^USE\b/i;
/**
 * 只把"语句开头（跳过前导注释后）的 CREATE TABLE"补成 IF NOT EXISTS。
 * ★ 这里必须是 \s+ 而不是 \s*：\s* 可以回退到 0 个字符，于是 `CREATE TABLE IF NOT EXISTS x`
 *   会在负向先行断言失败后仍然匹配（只吃掉到 TABLE 为止），归一结果变成 `CREATE TABLE IF NOT EXISTS  IF NOT EXISTS x`
 *   —— 幂等当场崩掉（本仓库的 smoke 就是这么抓出来的）。
 */
const CREATE_TABLE_RE = /^CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS\b)/i;

/**
 * 按顶层分号切语句：字符串/反引号内的分号、注释里的分号都不算分隔符。
 * 返回的每段**不含**分隔分号；`;;` 与尾部空语句会得到空段，随后被丢弃。
 */
function splitStatements(sql: string): string[] {
    const out: string[] = [];
    let buf = "";
    let i = 0;
    type State = "plain" | "single" | "double" | "backtick" | "line" | "block";
    let state: State = "plain";
    while (i < sql.length) {
        const ch = sql.charAt(i);
        const next = i + 1 < sql.length ? sql.charAt(i + 1) : "";
        if (state === "plain") {
            if (ch === "'") { state = "single"; buf += ch; i++; continue; }
            if (ch === '"') { state = "double"; buf += ch; i++; continue; }
            if (ch === "`") { state = "backtick"; buf += ch; i++; continue; }
            if (ch === "-" && next === "-") { state = "line"; buf += ch; i++; continue; }
            if (ch === "#") { state = "line"; buf += ch; i++; continue; }
            if (ch === "/" && next === "*") { state = "block"; buf += ch + next; i += 2; continue; }
            if (ch === ";") { out.push(buf); buf = ""; i++; continue; }
            buf += ch; i++; continue;
        }
        if (state === "line") {
            buf += ch;
            if (ch === "\n") state = "plain";
            i++; continue;
        }
        if (state === "block") {
            if (ch === "*" && next === "/") { buf += ch + next; state = "plain"; i += 2; continue; }
            buf += ch; i++; continue;
        }
        // 引号内：反斜杠转义（反引号里不转义）
        if (ch === "\\" && state !== "backtick" && next) { buf += ch + next; i += 2; continue; }
        buf += ch;
        const close = state === "single" ? "'" : state === "double" ? '"' : "`";
        if (ch === close) state = "plain";
        i++; continue;
    }
    if (buf) out.push(buf);
    return out;
}

/** 跳过前导注释/空白后的"首关键字区"（纯注释语句返回空串） */
function codeHead(trimmed: string): string {
    return trimmed.replace(LEADING_TRIVIA, "");
}

interface NormalizedStatement {
    text: string;
    /** 代码语句要补分号；纯注释块不补（否则 -- 注释后面挂分号会破坏幂等） */
    terminated: boolean;
}

function normalizeStatement(raw: string): NormalizedStatement | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;                                   // 空语句 / `;;`
    const code = codeHead(trimmed);
    if (!code) return { text: trimmed, terminated: false };       // 纯注释块：原样保留，不补分号
    if (CREATE_DATABASE_RE.test(code)) return null;               // CREATE DATABASE：库由连接串决定
    if (USE_RE.test(code)) return null;                          // USE：库由连接串决定
    const prefix = trimmed.slice(0, trimmed.length - code.length);
    return { text: prefix + code.replace(CREATE_TABLE_RE, "CREATE TABLE IF NOT EXISTS "), terminated: true };
}

/**
 * ★ DDL 归一化（幂等：normalizeDdl(normalizeDdl(x)) === normalizeDdl(x)）
 *   · 删掉 CREATE DATABASE ...; 与 USE ...;（库名/连接目标由 ${SPRING_DATASOURCE_URL} 决定）
 *   · CREATE TABLE（任意空白变体）统一成 CREATE TABLE IF NOT EXISTS
 *   · 其余语句、注释原样保留；`;;` 与空语句丢弃
 *   · 输入为空（或删完只剩空）→ 返回一行占位注释，保证 schema.sql 不是空文件
 */
export function normalizeDdl(raw: string | null | undefined): string {
    const source = (raw ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    if (!source.trim()) return `${EMPTY_SCHEMA_COMMENT}\n`;
    const kept: string[] = [];
    for (const chunk of splitStatements(source)) {
        const stmt = normalizeStatement(chunk);
        if (stmt != null) kept.push(stmt.terminated ? `${stmt.text};` : stmt.text);
    }
    if (kept.length === 0) return `${EMPTY_SCHEMA_COMMENT}\n`;
    return `${kept.join("\n\n")}\n`;
}

// ============================================================
// ② 前端骨架（内容写死；只有 title/appName/路由表是插值）
// ============================================================

const MAIN_TS = `import { createApp } from "vue";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
import App from "./App.vue";
import router from "./router";
import "./style.css";

const app = createApp(App);
app.use(router);
app.use(ElementPlus);
app.mount("#app");
`;

const APP_VUE = `<template>
  <router-view />
</template>
`;

const STYLE_CSS = `/* 全局样式与设计 token（引擎直出）。业务样式只引用 --cf-* 变量，不硬编码色值。 */
:root {
  --cf-brand: #2563eb;
  --cf-brand-hover: #1d4ed8;
  --cf-page: #f8fafc;
  --cf-surface: #ffffff;
  --cf-text: #0f172a;
  --cf-muted: #64748b;
  --cf-border: #e2e8f0;
  --cf-radius: 8px;
}

* { box-sizing: border-box; }

html,
body,
#app { height: 100%; }

body {
  margin: 0;
  background: var(--cf-page);
  color: var(--cf-text);
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
`;

const VITE_CONFIG_TS = `import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// 引擎直出（勿手改）：dev 端口与 /api 代理是契约的一部分。
// 后端整条 API 前缀走 servlet.context-path=/api，所以这里按 /api 原样转发（不 rewrite）。
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
      },
    },
  },
});
`;

const TSCONFIG_JSON = `{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "types": ["vite/client"],
    "useDefineForClassFields": true,
    "strict": true,
    "jsx": "preserve",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "src/**/*.d.ts", "src/**/*.vue", "vite.config.ts"]
}
`;

const REQUEST_TS = `import axios from "axios";

/**
 * 统一业务响应成功码。
 * ★ 来源：项目**冻结需求**（需求原文里的 {"code":200,...}），不是引擎默认值。
 *   引擎历史上写死过 1，与冻结需求的 200 直接冲突 —— 这里只做承载，不做发明。
 */
export const SUCCESS_CODE = 200;

/** JWT token 在 localStorage 的键；认证协议 = Authorization: Bearer <token> */
export const TOKEN_KEY = "token";

/** 后端统一响应体：{ code, msg, data }（字段名以冻结需求为准） */
export interface ApiResult<T = unknown> {
  code: number;
  msg: string;
  data: T;
}

/**
 * 全项目唯一请求封装（引擎直出）：业务文件只能 import 本文件，
 * 不得另起 services/api.js、utils/request.js 等第二份 axios/fetch 封装。
 * baseURL="/api" 与后端 servlet.context-path=/api 对应（控制器里不再重复写 /api）；
 * 开发期由 Vite dev server 代理到 http://127.0.0.1:8080。
 */
const request = axios.create({
  baseURL: "/api",
  timeout: 15000,
});

// 请求拦截器：localStorage 里有 token 才带 Authorization 头（没有就不加，避免把空串当凭证）
request.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) {
      config.headers.Authorization = \`Bearer \${token}\`;
    }
    return config;
  },
  (error) => Promise.reject(error),
);

// 响应拦截器：body.code !== SUCCESS_CODE（即 !== 200）一律 reject，成功则解包到 data（调用方直接拿业务数据）
// 注：axios 的拦截器类型要求回传 AxiosResponse，而本项目约定在拦截器里就解包成业务数据，
//     因此回调返回值标注 any（业务类型由调用处泛型声明）——否则 strict 下这一行必然报 TS2345。
request.interceptors.response.use(
  (response): any => {
    const body = response.data as ApiResult | undefined;
    if (body && typeof body === "object" && typeof body.code === "number" && body.code !== SUCCESS_CODE) {
      return Promise.reject(new Error(body.msg || \`业务失败(code=\${body.code})\`));
    }
    return body && typeof body === "object" && "data" in body ? body.data : body;
  },
  (error) => Promise.reject(error),
);

export default request;
`;

// ============================================================
// ③ 后端骨架（内容写死；只有 appName 是插值）
// ============================================================

const APPLICATION_JAVA = `package com.crewforge;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * 应用入口（引擎直出，勿改包名）。
 * 基础包固定 com.crewforge：本类必须就在该包，Spring Boot 才能扫到 com.crewforge.* 下的
 * Controller / Service / Config；Mapper 接口由 @MapperScan("com.crewforge.**.mapper") 覆盖。
 * 不使用 Lombok：生成项目不引入编译期注解处理器。
 */
@SpringBootApplication
@MapperScan("com.crewforge.**.mapper")
public class Application {

    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }
}
`;

// ============================================================
// ④ 插值工具（只做"防写坏"的最小处理：npm 名、XML/YAML 文本、路由路径）
// ============================================================

/** npm 包名/maven artifactId 必须是 url-safe 小写：仅当原值非法时才归一化 */
function slugName(raw: string): string {
    const value = (raw ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|-+$/g, "");
    return value || "crewforge-app";
}

function escapeXmlText(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlText(value: string): string {
    return escapeXmlText(value).replace(/"/g, "&quot;");
}

/** YAML 标量：一律双引号包裹（title/appName 可能含冒号、井号等 YAML 元字符） */
function yamlScalar(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function canonPath(raw: string | undefined): string {
    const value = (raw ?? "").trim().replace(/\\/g, "/");
    if (!value) return "";
    const withSlash = value.startsWith("/") ? value : `/${value}`;
    return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
}

function canonComponent(raw: string | undefined): string {
    let value = (raw ?? "").trim().replace(/\\/g, "/").replace(/^@\//, "").replace(/^\.\//, "");
    value = value.replace(/^\/+/, "");
    if (!value) return "";
    return value.startsWith("../") ? value : `../${value}`;
}

interface RenderedRoute {
    path: string;
    name: string;
    component: string;
}

function pathToName(path: string, index: number): string {
    const base = path.replace(/^\/+/, "").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
    return base || `page-${index + 1}`;
}

/** 路由名必须唯一（vue-router 对重名只警告并丢弃后注册者），冲突时后缀 -2/-3… */
function uniqueNames(rows: RenderedRoute[]): RenderedRoute[] {
    const used = new Set<string>();
    return rows.map(row => {
        let name = row.name;
        let n = 2;
        while (used.has(name)) name = `${row.name}-${n++}`;
        used.add(name);
        return { path: row.path, name, component: row.component };
    });
}

/**
 * 路由铁律：primaryRoute 指定的主页面必须**同时**注册到它自己的 path 和 "/"（同一 component），
 * 这样 "/" 一定是真实注册路由，而不是空 router-view 白屏。
 * 未给 primaryRoute 时以第一条已登记路由作为主页面；primaryRoute 不在契约里时回退第一条并 warn。
 * routes 为空 → 返回空表（可运行、不报错），由调用方 warn。
 */
function buildRoutes(input: SkeletonRoute[], primaryRoute: string | undefined): RenderedRoute[] {
    const seen = new Set<string>();
    const base: RenderedRoute[] = [];
    for (const [index, route] of input.entries()) {
        const path = canonPath(route?.path);
        if (!path || seen.has(path)) continue;
        const component = canonComponent(route?.component);
        if (!component) continue;
        seen.add(path);
        base.push({ path, name: (route?.name ?? "").trim() || pathToName(path, index), component });
    }
    if (base.length === 0) return base;

    const wanted = canonPath(primaryRoute);
    let primary = wanted ? base.find(route => route.path === wanted) : undefined;
    if (wanted && !primary) {
        console.warn(`[skeleton] primaryRoute=${wanted} 不在契约登记的路由里，回退到第一条路由 ${base[0]?.path ?? ""}`);
    }
    primary ??= base[0];
    if (!primary) return base;
    if (primary.path === "/") return uniqueNames(base);          // 主页面本身就是 "/"，无需别名

    // 剔除契约里已存在的 "/"（路径重复会让 vue-router 只认先注册的那条），再补一条指向同一 component
    const others = base.filter(route => route.path !== "/");
    return uniqueNames([...others, { path: "/", name: "home", component: primary.component }]);
}

function renderRouter(routes: RenderedRoute[]): string {
    const body = routes.length === 0
        ? "  // 本阶段契约未登记页面路由：路由表为空（引擎保证可运行不报错，/ 会白屏）\n"
        : `${routes.map(r => `  { path: "${r.path}", name: "${r.name}", component: () => import("${r.component}") },`).join("\n")}\n`;
    return `import { createRouter, createWebHistory } from "vue-router";
import type { RouteRecordRaw } from "vue-router";

// 引擎直出的路由登记（勿手改）：页面组件由任务产出，路由表由引擎写死，防"路径漂移"。
// primaryRoute 同时注册到 "/"，保证 "/" 命中真实页面而不是空 router-view。
const routes: RouteRecordRaw[] = [
${body}];

const router = createRouter({ history: createWebHistory(), routes });

export default router;
`;
}

function renderIndexHtml(title: string): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtmlText(title)}</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`;
}

function renderPackageJson(name: string): string {
    const pkg = {
        name,
        private: true,
        version: "0.0.0",
        type: "module",
        scripts: {
            dev: "vite",
            build: "vite build",
            preview: "vite preview",
            "type-check": "vue-tsc --noEmit",
        },
        dependencies: {
            axios: "^1.7.2",
            "element-plus": "^2.7.6",
            vue: "^3.4.31",
            "vue-router": "^4.4.0",
        },
        devDependencies: {
            "@vitejs/plugin-vue": "^5.0.5",
            typescript: "^5.4.5",
            vite: "^5.3.3",
            "vue-tsc": "^2.0.29",
        },
    };
    return `${JSON.stringify(pkg, null, 2)}\n`;
}

function renderPomXml(appName: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <!-- 引擎直出：Spring Boot 3 + Java 17 + MyBatis-Plus + MySQL 8；不引入编译期注解处理器 -->
    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>3.2.5</version>
        <relativePath/>
    </parent>

    <groupId>com.crewforge</groupId>
    <artifactId>${appName}</artifactId>
    <version>0.0.1-SNAPSHOT</version>
    <name>${escapeXmlText(appName)}</name>
    <description>CrewForge 生成的 Spring Boot 3 后端骨架</description>

    <properties>
        <java.version>17</java.version>
        <mybatis-plus.version>3.5.9</mybatis-plus.version>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
        <project.reporting.outputEncoding>UTF-8</project.reporting.outputEncoding>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-validation</artifactId>
        </dependency>
        <dependency>
            <groupId>com.baomidou</groupId>
            <artifactId>mybatis-plus-spring-boot3-starter</artifactId>
            <version>\${mybatis-plus.version}</version>
        </dependency>
        <dependency>
            <groupId>com.mysql</groupId>
            <artifactId>mysql-connector-j</artifactId>
            <scope>runtime</scope>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <scope>test</scope>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
            </plugin>
        </plugins>
    </build>
</project>
`;
}

function renderApplicationYml(appName: string): string {
    return `server:
  # 端口可由环境覆盖；整条 API 前缀走 servlet.context-path:/api
  # ★ 控制器里不要再写 /api（否则会变成 /api/api/...）
  port: \${SERVER_PORT:8080}
  servlet:
    context-path: /api

spring:
  application:
    name: ${yamlScalar(appName)}
  datasource:
    # ★ 数据库配置只能来自环境变量：不写 ':默认值' 回落，骨架里不出现任何字面量地址/账号/口令
    url: \${SPRING_DATASOURCE_URL}
    username: \${SPRING_DATASOURCE_USERNAME}
    password: \${SPRING_DATASOURCE_PASSWORD}
    driver-class-name: com.mysql.cj.jdbc.Driver
  sql:
    init:
      # schema.sql 由后端启动时真实执行（库名/连接目标由上面的连接串决定）
      mode: always
      schema-locations: classpath:schema.sql

mybatis-plus:
  configuration:
    map-underscore-to-camel-case: true
  type-aliases-package: com.crewforge
`;
}

// ============================================================
// ⑤ 公开入口
// ============================================================

function engineFile(path: string, content: string): SkeletonFile {
    return { path, content, owner: "engine" };
}

/** requestPath 覆盖：空/与其它骨架件重名时回落到标准路径 */
function resolveRequestPath(raw: string | undefined): string {
    const value = (raw ?? "").trim().replace(/\\/g, "/").replace(/^\.\/+/, "").toLowerCase();
    if (!value) return DEFAULT_REQUEST_PATH;
    if (!SKELETON_PATHS.includes(value) || value === DEFAULT_REQUEST_PATH) return value;
    return DEFAULT_REQUEST_PATH;
}

/**
 * ★ 骨架直出：返回恰好 SKELETON_PATHS 这些路径（requestPath 被显式覆盖时替换请求封装那一条）。
 * 每个 SkeletonFile 的 content 是可直接写盘的完整文件内容，owner 恒为 "engine"。
 */
export function renderSkeleton(o: SkeletonOpts): SkeletonFile[] {
    const appName = slugName(o.appName);
    const title = (o.title ?? "").trim() || appName;
    const routes = buildRoutes(o.routes ?? [], o.primaryRoute);
    if (routes.length === 0) {
        console.warn("[skeleton] 契约未登记任何页面路由：router 表为空（可运行但不注册任何页面，/ 会白屏）");
    }
    return [
        engineFile("frontend/index.html", renderIndexHtml(title)),
        engineFile("frontend/package.json", renderPackageJson(appName)),
        engineFile("frontend/vite.config.ts", VITE_CONFIG_TS),
        engineFile("frontend/tsconfig.json", TSCONFIG_JSON),
        engineFile("frontend/src/main.ts", MAIN_TS),
        engineFile("frontend/src/App.vue", APP_VUE),
        engineFile("frontend/src/style.css", STYLE_CSS),
        engineFile("frontend/src/router/index.ts", renderRouter(routes)),
        engineFile(resolveRequestPath(o.requestPath), REQUEST_TS),
        engineFile("backend/pom.xml", renderPomXml(appName)),
        engineFile(APPLICATION_PATH, APPLICATION_JAVA),
        engineFile("backend/src/main/resources/application.yml", renderApplicationYml(appName)),
        engineFile("backend/src/main/resources/schema.sql", normalizeDdl(o.ddl)),
    ];
}
