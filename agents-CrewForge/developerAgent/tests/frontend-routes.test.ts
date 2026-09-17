// ============================================================
// tests/frontend-routes.test.ts —— 前端路由登记硬闸（零 LLM、零浏览器）
//
//   为什么要有这个文件：checkFrontendRoutes 是"骨架空路由表 → / 白屏"那次事故
//   从一行 console.warn（[skeleton] 契约未登记任何页面路由：router 表为空…
//   / 会白屏）升级成的硬闸。它自身只有三种输入：磁盘上的目录、路由文件、App.vue——
//   真项目上跑一遍要整个生成流程，所以这里用 os.tmpdir() 里的最小产物树把
//   **全部判定分支**钉死，否则等于没验证。
//
//   覆盖：
//     ① path:"/" + component → 过（正常路由表）；
//     ② routes: [] 空表 → 红，且 detail 必须点名"空路由/白屏"；
//     ③ 无路由文件但 App.vue 自带内容 → 过（单文件应用）；
//     ④ 连 frontend/ 都没有 → 红，detail 说"产物缺失"；
//     ⑤ 有 path 但没一条命中 "/" → 红（首页缺登记）；
//     ⑥ 命中 "/" 却没绑组件 → 红；
//     ⑦ 无路由 + App.vue 只有 <router-view/> 空壳 → 红；
//     ⑧ 无路由又无 App.vue → 红；
//     ⑨ 前端目录名不是 frontend/（一级目录含 package.json + src/）→ 仍能定位；
//     ⑩ evidence 必须带 file:line 与计数（模型照抄即可行动，不再自行推导）。
// ============================================================

import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkFrontendRoutes } from "../../checkers";

// ---------- 临时产物树（os.tmpdir，测试结束统一清理） ----------

const tmpDirs: string[] = [];

/** 在临时目录里铺出给定相对路径 → 内容，返回项目根绝对路径 */
function fixture(files: Record<string, string>, prefix = "crewforge-routes-"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, "utf-8");
    }
    return dir;
}

afterAll(() => {
    for (const dir of tmpDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清理失败无所谓 */ }
    }
});

// ---------- 产物片段 ----------

const PKG_JSON = `{ "name": "demo-app", "private": true, "version": "0.0.0", "type": "module" }`;

const MAIN_TS = `import { createApp } from "vue";
import App from "./App.vue";
import router from "./router";

const app = createApp(App);
app.use(router);
app.mount("#app");
`;

/** 骨架直出的 App.vue：只有 router-view，路由表为空时它就是白屏 */
const APP_VUE_SHELL = `<template>
  <router-view />
</template>
`;

/** 真·单文件应用：模板自带可见内容（eval 的 page.home 要的正是可见文本 + <input>）
 *  —— 这里故意用 untyped ref，避免 .vue 里写 TS 影响 esbuild/tsc 之外的噪声 */
const APP_VUE_REAL = `<template>
  <main class="page">
    <h1>项目列表</h1>
    <input placeholder="搜索项目" />
  </main>
</template>

<script setup lang="ts">
const items: string[] = ["示例项目"];
</script>

<style scoped>
.page { padding: 16px; }
</style>
`;

/** 正常路由表：首页显式登记 path:"/" 并绑组件 */
const ROUTER_OK = `import { createRouter, createWebHistory } from "vue-router";
import type { RouteRecordRaw } from "vue-router";

const routes: RouteRecordRaw[] = [
  { path: "/", name: "home", component: () => import("../views/HomeView.vue") },
  { path: "/projects", name: "projects", component: () => import("../views/ProjectListView.vue") },
];

const router = createRouter({ history: createWebHistory(), routes });

export default router;
`;

/** 事故形态：骨架在"契约未登记页面路由"时直出的空表（能启动、/ 白屏） */
const ROUTER_EMPTY = `import { createRouter, createWebHistory } from "vue-router";
import type { RouteRecordRaw } from "vue-router";

// 本阶段契约未登记页面路由：路由表为空（引擎保证可运行不报错，/ 会白屏）
const routes: RouteRecordRaw[] = [];

const router = createRouter({ history: createWebHistory(), routes });

export default router;
`;

/** 有条目但首页没登记（没有 path:"/"，也没有 alias 兜底） */
const ROUTER_NO_HOME = `import { createRouter, createWebHistory } from "vue-router";

const routes = [
  { path: "/projects", name: "projects", component: () => import("../views/ProjectListView.vue") },
];

const router = createRouter({ history: createWebHistory(), routes });

export default router;
`;

/** 首页条目存在但没绑组件：匹配得上却无物可渲染 */
const ROUTER_HOME_NO_COMPONENT = `import { createRouter, createWebHistory } from "vue-router";

const routes = [
  { path: "/", name: "home" },
  { path: "/about", name: "about", component: () => import("../views/AboutView.vue") },
];

const router = createRouter({ history: createWebHistory(), routes });

export default router;
`;

// ============================================================
// ① 正常路由表 → 过
// ============================================================

describe("前端路由闸 / 正常产物", () => {
    it("path:\"/\" + component → ok，evidence 带 file:line 与计数", () => {
        const dir = fixture({
            "frontend/package.json": PKG_JSON,
            "frontend/src/main.ts": MAIN_TS,
            "frontend/src/App.vue": APP_VUE_SHELL,
            "frontend/src/router/index.ts": ROUTER_OK,
        });
        const r = checkFrontendRoutes(dir);
        expect(r.ok).toBe(true);
        expect(r.file).toBe("frontend/src/router/index.ts");
        // 证据必须能让模型直接行动：路由文件 + 行号 + 计数
        expect(r.evidence).toContain("frontend/src/router/index.ts:");
        expect(r.evidence).toMatch(/index\.ts:\d+/);
        expect(r.evidence).toContain("path 条目计数 = 2");
        expect(r.evidence).toContain("/projects");
        expect(r.detail).toMatch(/路由登记正常/);
    });

    it("前端目录名不是 frontend/（一级子目录含 package.json + src/）→ 仍能定位并判定", () => {
        const dir = fixture({
            "web/package.json": PKG_JSON,
            "web/src/App.vue": APP_VUE_SHELL,
            "web/src/router/index.ts": ROUTER_OK,
        });
        const r = checkFrontendRoutes(dir);
        expect(r.ok).toBe(true);
        expect(r.file).toBe("web/src/router/index.ts");
    });
});

// ============================================================
// ② 事故形态：空路由表 → 硬红
// ============================================================

describe("前端路由闸 / 空路由表（白屏事故）", () => {
    it("routes: [] → ok:false，detail 必须点名空路由/白屏", () => {
        const dir = fixture({
            "frontend/package.json": PKG_JSON,
            "frontend/src/main.ts": MAIN_TS,
            "frontend/src/App.vue": APP_VUE_SHELL,
            "frontend/src/router/index.ts": ROUTER_EMPTY,
        });
        const r = checkFrontendRoutes(dir);
        expect(r.ok).toBe(false);
        expect(r.detail).toMatch(/空路由|白屏/);
        expect(r.detail).toContain("page.home");
        // 证据给计数与定位，模型不必回读文件再数一遍
        expect(r.evidence).toContain("path 条目计数 = 0");
        expect(r.evidence).toContain("frontend/src/router/index.ts:");
        expect(r.file).toBe("frontend/src/router/index.ts");
    });

    it("有 path 条目但没一条命中 \"/\" → ok:false（首页缺登记）", () => {
        const dir = fixture({
            "frontend/package.json": PKG_JSON,
            "frontend/src/router/index.ts": ROUTER_NO_HOME,
        });
        const r = checkFrontendRoutes(dir);
        expect(r.ok).toBe(false);
        expect(r.detail).toMatch(/首页缺登记|白屏/);
        expect(r.evidence).toContain("path 条目计数 = 1");
        expect(r.evidence).toContain('"/" 命中 = 无');
    });

    it("命中 \"/\" 但没绑 component/components → ok:false", () => {
        const dir = fixture({
            "frontend/package.json": PKG_JSON,
            "frontend/src/router/index.ts": ROUTER_HOME_NO_COMPONENT,
        });
        const r = checkFrontendRoutes(dir);
        expect(r.ok).toBe(false);
        expect(r.detail).toMatch(/未绑定组件|白屏/);
        expect(r.evidence).toMatch(/index\.ts:\d+/);
    });
});

// ============================================================
// ③④ 无路由文件：单文件应用放行 / 空壳与缺产物判红
// ============================================================

describe("前端路由闸 / 无路由文件的分支", () => {
    it("没有路由文件但 App.vue 自带真实内容 → ok（单文件应用）", () => {
        const dir = fixture({
            "frontend/package.json": PKG_JSON,
            "frontend/src/main.ts": MAIN_TS,
            "frontend/src/App.vue": APP_VUE_REAL,
        });
        const r = checkFrontendRoutes(dir);
        expect(r.ok).toBe(true);
        expect(r.file).toBe("frontend/src/App.vue");
        expect(r.detail).toMatch(/单文件/);
        expect(r.evidence).toContain("frontend/src/App.vue");
    });

    it("没有路由文件且 App.vue 只有 <router-view /> → ok:false（空壳白屏）", () => {
        const dir = fixture({
            "frontend/package.json": PKG_JSON,
            "frontend/src/App.vue": APP_VUE_SHELL,
        });
        const r = checkFrontendRoutes(dir);
        expect(r.ok).toBe(false);
        expect(r.detail).toMatch(/App\.vue 是空壳|白屏/);
        expect(r.evidence).toContain("空壳");
    });

    it("既没路由文件也没 App.vue → ok:false（前端没有页面入口）", () => {
        const dir = fixture({
            "frontend/package.json": PKG_JSON,
            "frontend/src/main.ts": MAIN_TS,
        });
        const r = checkFrontendRoutes(dir);
        expect(r.ok).toBe(false);
        expect(r.detail).toMatch(/无路由也无单文件页/);
        expect(r.detail).toContain("src/App.vue");
        expect(r.file).toBeUndefined();
    });

    it("frontend/ 缺失（项目里根本没有前端）→ ok:false，detail 说明产物缺失", () => {
        const dir = fixture({ "README.md": "# 只有说明文件的项目" });
        const r = checkFrontendRoutes(dir);
        expect(r.ok).toBe(false);
        expect(r.detail).toContain("产物缺失");
        expect(r.evidence).toContain("frontend/ 不存在");
        expect(r.file).toBeUndefined();
    });

    it("项目目录本身不存在 → ok:false（产物缺失，不抛异常）", () => {
        const dir = path.join(os.tmpdir(), `crewforge-routes-missing-${process.pid}-${Date.now()}`);
        const r = checkFrontendRoutes(dir);
        expect(r.ok).toBe(false);
        expect(r.detail).toContain("产物缺失");
    });
});

// ============================================================
// ⑤ 纯函数与确定性：同一输入两次结果一致（闸门不许有隐藏状态）
// ============================================================

describe("前端路由闸 / 确定性", () => {
    it("同一产物树连查两次结果完全一致", () => {
        const dir = fixture({
            "frontend/package.json": PKG_JSON,
            "frontend/src/router/index.ts": ROUTER_EMPTY,
        });
        const a = checkFrontendRoutes(dir);
        const b = checkFrontendRoutes(dir);
        expect(b).toEqual(a);
    });
});
