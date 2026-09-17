// ============================================================
// install.ts —— 把引擎骨架写进产物树（★ 阶段 1 提交 2 的落地点）
//
//   放在这里而不是 architect 里的原因：写盘要过同名规则（引擎拥有件优先、可重复安装幂等），
//   而这些规则只依赖骨架模块自己的路径表。
//
//   顺序铁律：**引擎骨架必须在任务写盘之前落盘**，且任务永远不许覆盖它们
//   （ownership.ts 的 isEngineOwnedFile 已经把 ENGINE_OWNED_PATHS 当作拒绝清单）。
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { renderSkeleton, SKELETON_PATHS, ENGINE_OWNED_PATHS, type SkeletonRoute } from "./springVueMysql";
import { currentProjectId, projectDir } from "../../../runEnv";
import { writeWorkspace } from "../../../common";

export interface InstallSkeletonOpts {
    /** 应用名（package.json name / spring.application.name） */
    appName: string;
    /** index.html <title> */
    title: string;
    /** 架构师产出的 DDL 原文（会做归一化后落到 backend/src/main/resources/schema.sql） */
    ddl?: string | null;
    /** 契约页面清单里已登记的路由（可为空：路由另有 registerRoutes 机械登记） */
    routes?: SkeletonRoute[];
    /** 主页面路由（会同时登记到 /） */
    primaryRoute?: string;
    /**
     * 脚手架接管的维度（2026-09-17）：栈命中官方脚手架候选（matchScaffolds）时，
     * 该侧工程文件不预铺——初始化交给 Developer 走 `npm create vite` / `npm init`，
     * 手写只做兜底。此前骨架先行把脚手架架空（s4d 实测 `npm create` 0 次调用）。
     */
    skip?: ("frontend" | "backend")[];
}

export interface InstallSkeletonResult {
    written: string[];
    markerPatched: boolean;
    skipped: string[];
}

/**
 * registerRoutes 靠 `// {{ROUTES}}` 这个缝追加路由。
 * 骨架 router 一旦没有这个缝，路由就永远登记不进去（页面在但访问 404/白屏）——这里机械补上。
 */
export function ensureRouteMarker(routerSource: string): { source: string; patched: boolean } {
    if (routerSource.includes("// {{ROUTES}}")) return { source: routerSource, patched: false };
    const anchor = /const\s+routes\s*:\s*RouteRecordRaw\[\]\s*=\s*\[/;
    if (anchor.test(routerSource)) {
        return { source: routerSource.replace(anchor, m => `${m}\n  // {{ROUTES}}`), patched: true };
    }
    return { source: routerSource, patched: false };
}

/** 安装骨架（幂等：同一输入重复安装结果一致）。返回实际写入的路径。 */
export function installSkeleton(o: InstallSkeletonOpts): InstallSkeletonResult {
    const written: string[] = [];
    const skipped: string[] = [];
    const files = renderSkeleton({
        appName: o.appName,
        title: o.title,
        ddl: o.ddl ?? null,
        routes: o.routes ?? [],
        ...(o.primaryRoute ? { primaryRoute: o.primaryRoute } : {}),
    });
    let markerPatched = false;
    const skip = new Set(o.skip ?? []);
    for (const f of files) {
        if (skip.size > 0) {
            const dim = f.path.startsWith("frontend/") ? "frontend" : f.path.startsWith("backend/") ? "backend" : null;
            if (dim && skip.has(dim)) {
                skipped.push(`${f.path}：脚手架接管（${dim}），跳过`);
                continue;
            }
        }
        let content = f.content;
        if (f.path === "frontend/src/router/index.ts") {
            const patched = ensureRouteMarker(content);
            content = patched.source;
            markerPatched = patched.patched;
        }
        try {
            writeWorkspace(f.path, content);
            written.push(f.path);
        } catch (e) {
            skipped.push(`${f.path}：${(e as Error).message}`);
        }
    }
    return { written, markerPatched, skipped };
}

/** 骨架文件是否齐全（缺哪个报哪个；**不做"存在即通过"的软判断**） */
export function missingSkeletonFiles(projectId?: number | null, skip?: ("frontend" | "backend")[]): string[] {
    const pid = projectId ?? currentProjectId();
    const skipSet = new Set(skip ?? []);
    const paths = skipSet.size === 0
        ? [...SKELETON_PATHS]
        : SKELETON_PATHS.filter(rel => {
            const dim = rel.startsWith("frontend/") ? "frontend" : rel.startsWith("backend/") ? "backend" : null;
            return !(dim && skipSet.has(dim));
        });
    if (pid == null) return [...paths];
    const root = projectDir(pid);
    return paths.filter(rel => !fs.existsSync(path.join(root, rel)));
}

export function isEngineOwnedPath(rel: string): boolean {
    const key = (rel ?? "").replace(/\\/g, "/").replace(/^\.\/+/, "").toLowerCase();
    return ENGINE_OWNED_PATHS.some(p => p.toLowerCase() === key);
}

export { ENGINE_OWNED_PATHS, SKELETON_PATHS };
