// ============================================================
// tests/page-structure.test.ts —— 页面结构判据 + 验收脚本反投机（零 LLM）
//
//   为什么要有这个文件：`verify-p1-frontend.mjs` / `verify-p1-api.mjs` 属验收面，
//   它们只在**真项目**上跑（本任务不跑真实项目生成）。那么"占位页会不会被判过"
//   这件事就必须用**纯函数级**的测试钉死，否则等于没验证。
//
//   覆盖：
//     ① 只回 200 的占位响应（OK / placeholder / 空 div / 手写假 HTML）必须被判失败；
//     ② 真页面结构（首页 / 登录页 / 项目页 / 详情页）必须被判通过；
//     ③ 结构判据必须要求**多组独立结构**——含一个字符串不算过；
//     ④ API 验收脚本不得再出现固定业务值，且必须带"创建前作弊探针 + 跨进程持久化"。
// ============================================================

import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
    PAGE_CONTRACTS, pageStructureProblems, shellProblems, visibleText,
} from "../live/ts-site/scripts/verify-p1-frontend.mjs";

const SCRIPT_DIR = path.resolve(import.meta.dir, "..", "live", "ts-site", "scripts");
const apiSrc = fs.readFileSync(path.join(SCRIPT_DIR, "verify-p1-api.mjs"), "utf-8");
const feSrc = fs.readFileSync(path.join(SCRIPT_DIR, "verify-p1-frontend.mjs"), "utf-8");

/** 一个"真"SPA shell：像 vite build 出来的 dist/index.html */
const REAL_SHELL = `<!DOCTYPE html>
<html lang="zh-CN">
  <head><meta charset="UTF-8"><title>ts-site</title>
    <script type="module" crossorigin src="/assets/index-abc123.js"></script>
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>`;

const ASSETS = ["assets/index-abc123.js"];

// ============================================================
// ① shell：状态码之后的真判据
// ============================================================

describe("页面结构 / shell 判据（只回 200 不算过）", () => {
    it("res.send('OK') 这种占位响应 → 判失败", () => {
        const p = shellProblems("OK", "/", ASSETS);
        expect(p.length).toBeGreaterThan(0);
        expect(p.join("；")).toMatch(/占位|不足|不是 HTML/);
    });

    it("res.send('<html><body><div id=app></div></body></html>') 纯空 div（无内容无脚本）→ 判失败", () => {
        const p = shellProblems('<html><body><div id="app"></div></body></html>', "/");
        expect(p.length).toBeGreaterThan(0);
        expect(p.join("；")).toMatch(/空 div|没引用|body/);
    });

    it("Login page placeholder → 判失败", () => {
        const html = `<html><body><h1>Login page placeholder</h1>
            <script type="module" src="/assets/index-abc123.js"></script></body></html>`;
        const p = shellProblems(html, "/login", ASSETS);
        expect(p.length).toBeGreaterThan(0);
        expect(p.join("；")).toMatch(/占位|placeholder/);
    });

    it("空挂载点 + 引用真实产物脚本 → 通过（这是合法 SPA shell，不是空壳）", () => {
        expect(shellProblems(REAL_SHELL, "/", ASSETS)).toEqual([]);
    });

    it("手写假 HTML（没引用真实 dist 产物）→ 判失败", () => {
        const html = `<html><body><div id="app"></div>
            <header>欢迎来到我的项目站</header><main>项目列表</main>
            <script type="module" src="/fake/inline.js"></script></body></html>`;
        const p = shellProblems(html, "/", ASSETS);
        expect(p.length).toBeGreaterThan(0);
        expect(p.join("；")).toContain("dist 产物");
    });

    it("有可见内容但没引产物脚本 → 判失败（手写静态壳）", () => {
        const html = `<html><body><div id="app"></div><h1>项目列表</h1></body></html>`;
        const p = shellProblems(html, "/projects", ASSETS);
        expect(p.length).toBeGreaterThan(0);
        expect(p.join("；")).toContain("构建产物 js");
    });

    it("visibleText 剥掉 script/style 只留人眼可见文本", () => {
        expect(visibleText("<b>hi</b><script>var a=1</script><style>.x{}</style>")).toBe("hi");
    });
});

// ============================================================
// ②③ 页面结构组：多组独立成立，含字符串不算过
// ============================================================

describe("页面结构 / 结构组判据", () => {
    it("登录页占位文本 → 判失败", () => {
        const p = pageStructureProblems("login", "Login page placeholder", "stub");
        expect(p.length).toBeGreaterThan(0);
        expect(p.join("；")).toMatch(/缺结构/);
    });

    it("真登录页结构（账号框 + 密码框 + 提交 + 文案）→ 通过", () => {
        const login = `
            <template><form @submit.prevent="handleLogin">
              <label>用户名</label><input v-model="form.username" name="username" type="text" />
              <label>密码</label><input v-model="form.password" name="password" type="password" />
              <button type="submit">登录</button>
            </form></template>`;
        expect(pageStructureProblems("login", login, "src 源码")).toEqual([]);
    });

    it("只写一个字符串「projects」冒充项目页 → 仍判失败（缺其它结构组）", () => {
        const p = pageStructureProblems("projects", "projects", "stub");
        expect(p.length).toBeGreaterThan(0);
        expect(p.join("；")).toMatch(/缺结构/);
    });

    it("真项目页结构（列表容器 + 创建入口 + 接口渲染 + 状态文案）→ 通过", () => {
        const projects = `
            <template><section class="projects-list">
              <h2>Projects 项目</h2>
              <form @submit.prevent="createProject"><input v-model="draft.title" placeholder="新项目标题" /><button>创建</button></form>
              <ul><li v-for="p in items" :key="p.id">{{ p.title }}</li></ul>
              <p v-if="loading">加载中…</p><p v-else-if="!items.length">暂无项目</p>
            </section></template>
            <script setup>const items = await fetch('/api/projects').then(r => r.json())</script>`;
        expect(pageStructureProblems("projects", projects, "src 源码")).toEqual([]);
    });

    it("首页判据要求导航 + 主体 + 内容区块三组同时成立", () => {
        expect(PAGE_CONTRACTS.home.groups.length).toBe(3);
        expect(pageStructureProblems("home", "<nav></nav>", "stub").length).toBeGreaterThan(0);
        const home = `<template><div class="app-shell"><nav>导航</nav>
            <main><section class="hero">首页</section></main></div></template>`;
        expect(pageStructureProblems("home", home, "src 源码")).toEqual([]);
    });

    it("详情页要有 slug 取数 + 字段渲染 + 状态文案", () => {
        expect(pageStructureProblems("projectDetail", "detail", "stub").length).toBeGreaterThan(0);
        const detail = `<template><div v-if="loading">加载中</div>
            <div v-else><h1>{{ project.title }}</h1><p>{{ project.description }}</p></div></template>
            <script setup>const p = await fetch(\`/api/projects/\${route.params.slug}\`)</script>`;
        expect(pageStructureProblems("projectDetail", detail, "src 源码")).toEqual([]);
    });

    it("未知页面种类 → 明确报错，不静默通过", () => {
        expect(pageStructureProblems("nope", "whatever", "stub").length).toBeGreaterThan(0);
    });
});

// ============================================================
// ④ 验收脚本本身的反投机结构（防止有人把固定答案改回来）
// ============================================================

describe("验收脚本 / 反投机结构", () => {
    it("API 验收脚本不得再出现固定业务值 alpha-one / hidden-one", () => {
        expect(apiSrc).not.toContain("alpha-one");
        expect(apiSrc).not.toContain("hidden-one");
    });

    it("API 验收脚本每轮生成 nonce，并用它派生 slug / 标题 / 描述 / 查询参数", () => {
        expect(apiSrc).toMatch(/const nonce\s*=/);
        expect(apiSrc).toMatch(/createdSlug\s*=\s*`probe-\$\{nonce\}`/);
        expect(apiSrc).toMatch(/hiddenSlug\s*=\s*`hidden-\$\{nonce\}`/);
        expect(apiSrc).toMatch(/createdTitle[\s\S]{0,60}nonce/);
        expect(apiSrc).toMatch(/createdDesc[\s\S]{0,60}nonce/);
        // 更新/404/非法输入也要带 nonce——固定值会被"只认某个值"的分支骗过
        expect(apiSrc).toMatch(/updatedTitle[\s\S]{0,60}nonce/);
        expect(apiSrc).toMatch(/absentSlug[\s\S]{0,60}nonce/);
    });

    it("API 验收脚本必须带「创建前作弊探针」：POST 之前不许存在本轮 nonce 数据", () => {
        expect(apiSrc).toMatch(/作弊探针/);
        expect(apiSrc).toMatch(/检测到作弊/);
        // 探针必须在首次 POST 之前（按源码位置判断）
        expect(apiSrc.indexOf("检测到作弊")).toBeLessThan(apiSrc.indexOf('await hit("/api/projects", PJ({'));
    });

    it("API 验收脚本必须带跨进程持久化验证（起第二个服务进程再查）", () => {
        expect(apiSrc).toMatch(/startServer\("B/);
        expect(apiSrc).toMatch(/process\.on\("exit", cleanupAll\)|cleanupAll\(\)/);
        expect(apiSrc).toMatch(/未持久化/);
        expect(apiSrc).toMatch(/内存数组 \/ 模块级变量冒充持久化/);
    });

    it("前端验收脚本必须带页面结构判据，且按路由是否声明决定是否查登录页", () => {
        expect(feSrc).toMatch(/PAGE_CONTRACTS/);
        expect(feSrc).toMatch(/pageStructureProblems/);
        expect(feSrc).toMatch(/shellProblems/);
        expect(feSrc).toMatch(/hasRoute\("\/login"\)/);
        // 深链必须带 nonce，不能是固定 slug
        expect(feSrc).toMatch(/probeSlug\s*=\s*`probe-\$\{nonce\}`/);
    });

    it("两个脚本都不得自己写目标项目文件（不落盘 nonce / 不预置种子）", () => {
        // 允许的写操作只有：删自己建的独立验证库（rmSync + DB 变量）
        const writes = [...feSrc.matchAll(/writeFileSync\(/g)];
        expect(writes.length).toBe(0);
        const apiWrites = [...apiSrc.matchAll(/writeFileSync\(/g)];
        expect(apiWrites.length).toBe(0);
        expect(apiSrc).toMatch(/rmSync\(DB \+ suffix/);
    });
});
