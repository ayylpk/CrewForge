import fs from "node:fs";
import path from "node:path";
import { writeWorkspace } from "./common";
import type { ExecTask } from "./common";
import { projectDir } from "./runEnv";
import { baselinePromptBlock, CANONICAL_REQUEST_PATH } from "./baseline";

/** Engine-owned Vue bootstrap files. A legacy backend entry is retained only for cleanup. */
export const ENGINE_OWNED = [
    "frontend/src/main.ts",
    "frontend/src/App.vue",
    "frontend/src/router/index.ts",
    "backend/src/app.js",
] as const;

export const MAIN_TS = `import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import App from './App.vue'
import router from './router'

createApp(App).use(ElementPlus).use(router).mount('#app')
`;

export const APP_VUE = `<template>
  <router-view />
</template>
`;

/** The marker is intentionally stable: route registration is deterministic and idempotent. */
export const ROUTER_INDEX_TS = `import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  // {{ROUTES}}
]

const router = createRouter({ history: createWebHistory(), routes })

export default router
`;

/** @deprecated Kept for callers that imported the old symbol. Spring Boot never receives it. */
export const BACKEND_APP_JS = "";

export function canonicalizeRoot(input: string): string {
    const value = (input ?? "").replace(/\\/g, "/");
    return value
        .replace(/^(?:web|client|ui)(\/.*)$/i, "frontend$1")
        .replace(/^server(\/.*)$/i, "backend$1");
}

export function rebaseBackendPath(input: string): string {
    const value = canonicalizeRoot(input);
    const match = /^backend\/(?!src\/)(.+)$/i.exec(value);
    if (!match?.[1] || !match[1].includes("/")) return value;
    return `backend/src/${match[1]}`;
}

export function rebaseRootSrc(files: { path: string }[]): void {
    if (!files.some(file => /^frontend\//i.test(canonicalizeRoot(file.path)))) return;
    for (const file of files) {
        const value = canonicalizeRoot(file.path);
        if (/^src\//i.test(value)) file.path = `backend/${value}`;
    }
}

/** Current engine ownership excludes backend/src/app.js; that file is a legacy artifact to remove. */
export function isEngineOwned(input: string): boolean {
    const value = canonicalizeRoot(input);
    return /^(frontend\/src\/(?:main\.ts|App\.vue|router\/index\.(?:ts|js)))$/i.test(value);
}

function isLegacyBackendEntry(input: string): boolean {
    return /^backend\/src\/(?:app|server)\.(?:js|ts)$/i.test(canonicalizeRoot(input));
}

function samePath(a: string, b: string): boolean {
    return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
}

function addFrontendDependencies(content: string): string {
    try {
        const packageJson = JSON.parse(content) as Record<string, any>;
        const dependencies = { ...(packageJson.dependencies ?? {}) };
        if (!dependencies["vue-router"]) dependencies["vue-router"] = "^4";
        if (!dependencies["element-plus"]) dependencies["element-plus"] = "^2";
        packageJson.dependencies = dependencies;
        return JSON.stringify(packageJson, null, 2);
    } catch {
        return content;
    }
}

/** Normalize model output before any task or artifact reaches a worker. */
export function enforceEngineFoundation(files: { path: string; content: string }[]): void {
    if (files.length === 0) return;
    for (const file of files) file.path = canonicalizeRoot(file.path);
    rebaseRootSrc(files);
    for (const file of files) file.path = rebaseBackendPath(file.path);

    const hasFrontend = files.some(file => /^frontend\//i.test(file.path));
    const dropped = files.filter(file => isEngineOwned(file.path) || isLegacyBackendEntry(file.path));
    for (const file of dropped) {
        const index = files.indexOf(file);
        if (index >= 0) files.splice(index, 1);
    }
    if (dropped.length > 0) console.log(`[foundation] removed ${dropped.length} engine/legacy entry file(s)`);

    for (const file of files) {
        if (hasFrontend && /^frontend\/package\.json$/i.test(file.path)) file.content = addFrontendDependencies(file.content);
    }

    const put = (filePath: string, content: string) => {
        if (!files.some(file => samePath(file.path, filePath))) files.push({ path: filePath, content });
    };
    if (hasFrontend) {
        put("frontend/src/main.ts", MAIN_TS);
        put("frontend/src/App.vue", APP_VUE);
        put("frontend/src/router/index.ts", ROUTER_INDEX_TS);
    }
    console.log(`[foundation] bootstrap ready: frontend=${hasFrontend ? "yes" : "no"}, backend=Spring Boot`);
}

export function bannedDependencyList(stack: unknown): string[] {
    if (stack == null) return [];
    const text = JSON.stringify(stack).toLowerCase();
    const banned: string[] = [];
    if (/sqlite/.test(text) && !/mysql/.test(text)) banned.push("mysql2", "mysql", "knex", "sequelize", "sequelize-core");
    if (!/redis/.test(text)) banned.push("redis", "ioredis");
    return banned;
}

export function tidyExecTasks(tasks: ExecTask[], stack: unknown): ExecTask[] {
    const banned = bannedDependencyList(stack);
    const ruleBlock = [
        baselinePromptBlock(),
        `禁止依赖：${banned.join(", ") || "（无）"}`,
        "任务只能写入自身 files；引擎拥有的入口、根组件和路由表不得出现在任务 files 中。",
        `请求封装唯一路径：${CANONICAL_REQUEST_PATH}；不要发明 services/api.js、utils/request 或其他 wrapper。`,
    ].join("\n");
    const owners = new Map<string, string>();
    return tasks.map(task => {
        const files: string[] = [];
        const shared: string[] = [];
        for (const rawPath of task.files ?? []) {
            const filePath = rebaseBackendPath(canonicalizeRoot(rawPath));
            if (isEngineOwned(filePath) || isLegacyBackendEntry(filePath)) continue;
            const key = filePath.toLowerCase();
            const owner = owners.get(key);
            if (owner && owner !== task.id) {
                shared.push(`${filePath}（创建任务 ${owner}，其余任务只 import）`);
                continue;
            }
            owners.set(key, task.id);
            files.push(filePath);
        }
        return {
            ...task,
            files,
            description: `${task.description ?? ""}${shared.length ? `\n\n共享文件归属：${shared.join("；")}` : ""}\n\n${ruleBlock}`,
        };
    });
}

export function parsePageEntries(contractMd: string | null): { path: string; file: string; task: string }[] {
    if (!contractMd) return [];
    const result: { path: string; file: string; task: string }[] = [];
    for (const line of contractMd.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("- ")) continue;
        const arrow = trimmed.indexOf("→") >= 0 ? "→" : "->";
        const arrowAt = trimmed.indexOf(arrow);
        if (arrowAt < 0) continue;
        const route = trimmed.slice(2, arrowAt).trim();
        const rest = trimmed.slice(arrowAt + arrow.length).trim();
        const ownerAt = rest.search(/登记任务|register task/);
        const file = (ownerAt >= 0 ? rest.slice(0, ownerAt) : rest.split(/\s+/)[0] ?? "")
            .replace(/[（(]\s*$/, "").replace(/\\/g, "/").trim();
        const task = (ownerAt >= 0 ? rest.slice(ownerAt) : "").match(/(?:登记任务|register task)\s+([\w-]+)/)?.[1] ?? "";
        if (route && file && task && route !== "(组件)" && route !== "（组件）") result.push({ path: route, file, task });
    }
    return result;
}

export async function registerRoutes(pid: number | null, task: ExecTask, contractMd: string | null): Promise<number> {
    if (pid == null || task.layer !== "frontend") return 0;
    const own = parsePageEntries(contractMd).filter(entry => task.files.some(file => samePath(file, entry.file)));
    if (own.length === 0) return 0;
    const routerPath = "frontend/src/router/index.ts";
    let source: string;
    try {
        const fullPath = path.join(projectDir(pid), routerPath);
        source = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf8") : ROUTER_INDEX_TS;
    } catch {
        return 0;
    }
    if (!source.includes("// {{ROUTES}}")) return 0;
    const lines: string[] = [];
    for (const entry of own) {
        let relative = path.posix.relative("frontend/src/router", entry.file);
        if (!relative.startsWith(".")) relative = `./${relative}`;
        if (source.includes(`import(\"${relative}\")`)) continue;
        const name = entry.path.replace(/^\/+/, "").replace(/[^\w]+/g, "-") || "page";
        lines.push(`  { path: \"${entry.path}\", name: \"${name}\", component: () => import(\"${relative}\") },`);
    }
    if (lines.length === 0) return 0;
    source = source.replace("// {{ROUTES}}", `// {{ROUTES}}\n${lines.join("\n")}`);
    writeWorkspace(routerPath, source);
    return lines.length;
}

export interface ParsedApiRoute {
    method: string;
    path: string;
    parameters: string[];
    returnFields: string[];
}

function normalizeApiPath(input: string): string {
    let value = input.replace(/\$\{[^}]*\}/g, ":id").replace(/\{[^}]*\}/g, ":id").replace(/\/+$/, "");
    if (!value.startsWith("/")) value = `/${value}`;
    if (value !== "/api" && !value.startsWith("/api/")) value = `/api${value}`;
    return value || "/api";
}

function routeParameters(routePath: string): string[] {
    return [...routePath.matchAll(/:([\w-]+)|\{([\w-]+)\}/g)].map(match => match[1] ?? match[2] ?? "");
}

export function parseSpringRoutes(source: string): ParsedApiRoute[] {
    const result: ParsedApiRoute[] = [];
    const annotation = /@(Get|Post|Put|Delete|Patch)Mapping\s*(?:\(\s*(?:(?:value|path)\s*=\s*)?["']([^"']*)["'][^)]*\)|\(\s*\))?/g;
    for (const match of source.matchAll(annotation)) {
        const method = (match[1] ?? "").toUpperCase();
        const routePath = normalizeApiPath(match[2] || "/");
        result.push({ method, path: routePath, parameters: routeParameters(routePath), returnFields: [] });
    }
    const requestMapping = /@RequestMapping\s*\(([^)]*)\)[\s\S]{0,500}?public\s+[\w$.<>?, ]+\s+\w+\s*\(/g;
    for (const match of source.matchAll(requestMapping)) {
        const args = match[1] ?? "";
        const method = args.match(/RequestMethod\.(GET|POST|PUT|DELETE|PATCH)/i)?.[1]?.toUpperCase();
        const route = args.match(/["']([^"']+)["']/)?.[1];
        if (!method || !route) continue;
        const normalized = normalizeApiPath(route);
        if (!result.some(item => item.method === method && item.path === normalized)) {
            result.push({ method, path: normalized, parameters: routeParameters(normalized), returnFields: [] });
        }
    }
    return result;
}

export function parseFrontendApiCalls(source: string): ParsedApiRoute[] {
    const result: ParsedApiRoute[] = [];
    const re = /\b(?:request|api|http|axios)\s*\.\s*(get|post|put|delete|patch)\s*\(\s*([`'\"])([\s\S]*?)\2/g;
    for (const match of source.matchAll(re)) {
        const method = (match[1] ?? "").toUpperCase();
        const route = normalizeApiPath(match[3] ?? "");
        if (route && !result.some(item => item.method === method && item.path === route)) {
            result.push({ method, path: route, parameters: routeParameters(route), returnFields: [] });
        }
    }
    return result;
}

function parseLegacyRoutes(source: string): ParsedApiRoute[] {
    const result: ParsedApiRoute[] = [];
    const re = /\b(?:router|app|api)\s*\.\s*(get|post|put|delete|patch)\s*\(\s*(["'])([^"']+)\2/gi;
    for (const match of source.matchAll(re)) {
        const routePath = normalizeApiPath(match[3] ?? "");
        result.push({ method: (match[1] ?? "").toUpperCase(), path: routePath, parameters: routeParameters(routePath), returnFields: [] });
    }
    return result;
}

export function extractBackendRoutes(codes: string[]): { m: string; p: string }[] {
    return codes.flatMap(source => [...parseSpringRoutes(source), ...parseLegacyRoutes(source)]).map(route => ({ m: route.method.toLowerCase(), p: route.path }));
}

export function extractApiCalls(codes: string[]): { m: string; p: string }[] {
    return codes.flatMap(source => parseFrontendApiCalls(source)).map(route => ({ m: route.method.toLowerCase(), p: route.path }));
}

function expectedApisOf(task: ExecTask): { m: string; p: string }[] {
    const result: { m: string; p: string }[] = [];
    const re = /^\s*-\s*(GET|POST|PUT|DELETE|PATCH)\s+(\S+?)(?=\s|[（(]|$)/gim;
    for (const match of task.description.matchAll(re)) result.push({ m: (match[1] ?? "").toLowerCase(), p: normalizeApiPath(match[2] ?? "") });
    return result;
}

export function pairIntegrationCheck(back: ExecTask, _front: ExecTask, backCodes: string[], frontCodes: string[]): string[] {
    const routes = extractBackendRoutes(backCodes);
    const calls = extractApiCalls(frontCodes);
    if (routes.length === 0 || calls.length === 0) return [];
    const routeKeys = new Set(routes.map(route => `${route.m} ${route.p}`));
    const expectedKeys = new Set([...expectedApisOf(back), ...routes].map(route => `${route.m} ${route.p}`));
    const problems: string[] = [];
    for (const expected of expectedApisOf(back)) {
        if (!routeKeys.has(`${expected.m} ${expected.p}`)) problems.push(`后端未实现契约接口 ${expected.m.toUpperCase()} ${expected.p}`);
    }
    for (const call of calls) {
        if (!expectedKeys.has(`${call.m} ${call.p}`)) problems.push(`前端调用 ${call.m.toUpperCase()} ${call.p} 在后端路由和任务契约中不存在`);
    }
    return [...new Set(problems)];
}
