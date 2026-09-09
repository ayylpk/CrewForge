/**
 * CrewForge 的项目基线。
 *
 * PROJECT_BASELINE 是没有架构选型时的兼容默认值，不是不可修改的技术栈。
 * 架构师输出 stack 后，所有下游都应使用 resolveProjectBaseline(stack) 得到
 * 本项目唯一的最终基线。API 响应、认证头和请求封装路径是平台级契约；框架、
 * 组件库、构建工具、ORM 和数据库都允许随项目选择改变。
 */
export interface ProjectBaseline {
    frontend: {
        framework: string;
        ui: string;
        build: string;
        /** Engine convention: one stable import target for all frontend workers. */
        requestPath: string;
        enabled: boolean;
    };
    backend: {
        framework: string;
        language: string;
        orm: string;
        enabled: boolean;
    };
    database: string;
    auth: string;
    apiPrefix: string;
    response: {
        successCode: number;
        errorCode: number;
        messageField: string;
    };
}

export const PROJECT_BASELINE: ProjectBaseline = {
    frontend: {
        framework: "Vue 3",
        ui: "Element Plus",
        build: "Vite",
        requestPath: "frontend/src/utils/request.ts",
        enabled: true,
    },
    backend: {
        framework: "Spring Boot 3",
        language: "Java 17",
        orm: "MyBatis-Plus",
        enabled: true,
    },
    database: "MySQL 8",
    auth: "JWT",
    apiPrefix: "/api",
    response: {
        successCode: 1,
        errorCode: 0,
        messageField: "msg",
    },
};

export const API_SUCCESS_CODE = PROJECT_BASELINE.response.successCode;
export const API_ERROR_CODE = PROJECT_BASELINE.response.errorCode;
export const CANONICAL_REQUEST_PATH = PROJECT_BASELINE.frontend.requestPath;

type RecordLike = Record<string, unknown>;

function record(value: unknown): RecordLike {
    return value && typeof value === "object" && !Array.isArray(value) ? value as RecordLike : {};
}

function text(value: unknown, fallback: string): string {
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

function section(stack: unknown, name: string): RecordLike {
    const root = record(stack);
    const techniques = record(root.techniques);
    return record(techniques[name] ?? root[name]);
}

function legacyModuleTech(stack: unknown): { frontend: string; backend: string } {
    const rows = record(stack).moduleTech;
    if (!Array.isArray(rows)) return { frontend: "", backend: "" };
    const first = record(rows[0]);
    return {
        frontend: typeof first.frontend === "string" ? first.frontend : "",
        backend: typeof first.backend === "string" ? first.backend : "",
    };
}

function firstTechnology(value: string, preferred: RegExp, fallback: string): string {
    const match = value.match(preferred)?.[0]?.trim();
    if (match) return match;
    const first = value.split("+")[0]?.trim();
    return first || fallback;
}

/** Resolve the final baseline from current and legacy architecture stack shapes. */
export function resolveProjectBaseline(stack: unknown): ProjectBaseline {
    const root = record(stack);
    const techniques = record(root.techniques);
    const frontend = section(stack, "frontend");
    const backend = section(stack, "backend");
    const legacy = legacyModuleTech(stack);
    const database = record(techniques.database ?? root.database);
    const auth = record(techniques.auth ?? root.auth);
    const frontendSelected = Object.keys(frontend).length > 0;
    const backendSelected = Object.keys(backend).length > 0;
    const databaseName = text(database.type ?? database.name ?? root.database, PROJECT_BASELINE.database);
    const authName = text(auth.type ?? auth.name ?? root.auth, PROJECT_BASELINE.auth);
    const rawPrefix = text(root.apiPrefix, PROJECT_BASELINE.apiPrefix);

    return {
        frontend: {
            framework: text(frontend.framework ?? frontend.name, firstTechnology(legacy.frontend, /(?:Vue|React|Angular|Svelte|Solid)(?:\s+[^+]+)?/i, PROJECT_BASELINE.frontend.framework)),
            ui: text(frontend.ui ?? frontend.uiLibrary ?? frontend.componentLibrary, firstTechnology(legacy.frontend, /(?:Element Plus|Ant Design|Ant Design Vue|TDesign|Material UI|MUI|Naive UI)/i, PROJECT_BASELINE.frontend.ui)),
            build: text(frontend.build ?? frontend.buildTool, firstTechnology(legacy.frontend, /(?:Vite|Webpack|Rspack|Next\.js|Nuxt)/i, PROJECT_BASELINE.frontend.build)),
            // This path is intentionally stable: it is the import contract that prevents ghost wrappers.
            requestPath: PROJECT_BASELINE.frontend.requestPath,
            enabled: bool(frontend.enabled, frontendSelected ? true : PROJECT_BASELINE.frontend.enabled),
        },
        backend: {
            framework: text(backend.framework ?? backend.name, firstTechnology(legacy.backend, /(?:Spring Boot|FastAPI|Django|Express|NestJS|Rails|Laravel|ASP\.NET Core)(?:\s+\d+(?:\.\d+)*)?/i, PROJECT_BASELINE.backend.framework)),
            language: text(backend.language ?? backend.runtime, firstTechnology(legacy.backend, /(?:Java|Python|TypeScript|JavaScript|Go|Ruby|PHP|C#)(?:\s+\d+(?:\.\d+)*)?/i, PROJECT_BASELINE.backend.language)),
            orm: text(backend.orm ?? backend.persistence, firstTechnology(legacy.backend, /(?:MyBatis-Plus|SQLAlchemy|Django ORM|Prisma|TypeORM|Hibernate|Entity Framework)(?:\s+\w+)?/i, PROJECT_BASELINE.backend.orm)),
            enabled: bool(backend.enabled, backendSelected ? true : PROJECT_BASELINE.backend.enabled),
        },
        database: databaseName,
        auth: authName,
        apiPrefix: rawPrefix.startsWith("/") ? rawPrefix.replace(/\/$/, "") || "/" : `/${rawPrefix}`,
        response: { ...PROJECT_BASELINE.response },
    };
}

export function baselinePromptBlock(baseline: ProjectBaseline = PROJECT_BASELINE): string {
    const frontend = baseline.frontend.enabled
        ? `${baseline.frontend.framework} + ${baseline.frontend.ui} + ${baseline.frontend.build}`
        : "不做 Web 前端";
    const backend = baseline.backend.enabled
        ? `${baseline.backend.framework}，${baseline.backend.language}，${baseline.backend.orm}`
        : "不做后端服务";
    return [
        "## CrewForge 项目技术基线（由架构师选择，代码闸门以本项目最终值为准）",
        `- 前端：${frontend}`,
        `- 后端：${backend}`,
        `- 数据库：${baseline.database}`,
        `- 认证：${baseline.auth}；认证 token 通过 Authorization 请求头发送（若架构师明确选择其他协议，必须在契约中说明）`,
        `- API 前缀：${baseline.apiPrefix}`,
        `- 响应：{ code, msg, data }；成功 code=${baseline.response.successCode}，失败 code=${baseline.response.errorCode}`,
        `- 请求封装唯一标准路径：${baseline.frontend.requestPath}；业务文件只能 import 它，不得另起 api/services/request wrapper`,
    ].join("\n");
}
