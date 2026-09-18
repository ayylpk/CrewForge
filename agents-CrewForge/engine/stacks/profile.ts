// ============================================================
// profile.ts —— 技术栈描述符（StackProfile）：让"任意栈"变便宜的唯一办法
//
//   为什么需要它（2026-09-10 实测）：
//     引擎里曾有四条组件库规约常量（TDesign×2 + Element Plus×2），**全部是死代码、零引用**；
//     同时 architect 又强制把 element-plus 写进 package.json；而组件幻觉闸是空实现
//     `extraGate: async () => []`。结果是"模型不知用哪个库 + 依赖被强装 + 校验空转"。
//
//   原则（与自定义层同一条）：
//     **能承诺的边界 = 验证器的覆盖边界。**
//     有验证器的栈 → 承诺"可编译/可启动/可测"；没有的栈 → 允许生成，但报告必须标"未验证"，
//     绝不允许静默地算作通过（F-3：Java 本可验证却没验证，3 处幻觉 API 一路绿灯）。
//
//   加一条栈的成本：不是"一套引擎"，而是**一张描述符**——编译/启动/HTTP 的机器是共享的。
// ============================================================

import { PROJECT_BASELINE, type ProjectBaseline } from "../../baseline";

/** 组件库标签规约（幻觉闸判据；只对"连字符小写标签"的 Vue 家族生效） */
export interface ComponentRules {
    /** 允许的第三方库标签前缀（如 Element Plus = "el-"）；空数组=不做前缀校验（未验证栈/React 家族） */
    allowedPrefixes: string[];
    /** 明确禁止的其它组件库（前缀 → 库名，报错文案用） */
    forbidden: { prefix: string; name: string }[];
}

export interface StackProfile {
    id: string;
    label: string;
    /** ★ 是否有验证器。false = 该栈产物只能"未验证"交付，报告必须标红 */
    verified: boolean;
    match(b: ProjectBaseline): boolean;
    /** 一行摘要（报告/日志用） */
    describe(b: ProjectBaseline): string;
    /** 注入工位 prompt 的组件库/请求封装/样式变量规约 */
    uiRule(b: ProjectBaseline): string;
    componentRules(b: ProjectBaseline): ComponentRules;
    /** 引擎拥有件：任何任务不得产出或修改 */
    engineOwnedFiles: string[];
    /** 骨架相对路径（M4 骨架直出用） */
    skeletonFiles: string[];
    /** 验证器规格（M3 用） */
    verify: { compile: string; boot: boolean; testInjection: "http-cases" | "openapi" | "e2e" | "none" };
}

// ---------- 组件库前缀知识（Vue 家族） ----------
const VUE_LIB_PREFIX: { prefix: string; name: string; re: RegExp }[] = [
    { prefix: "el-", name: "Element Plus", re: /element/i },
    { prefix: "t-", name: "TDesign Vue Next", re: /tdesign/i },
    { prefix: "a-", name: "Ant Design Vue", re: /ant\s*design/i },
    { prefix: "n-", name: "Naive UI", re: /naive/i },
    { prefix: "van-", name: "Vant", re: /vant/i },
    { prefix: "v-", name: "Vuetify", re: /vuetify/i },
    { prefix: "q-", name: "Quasar", re: /quasar/i },
];

function isVueFamily(b: ProjectBaseline): boolean {
    return /vue/i.test(b.frontend.framework);
}

/** 由基线的组件库名 → 允许前缀 + 其它库的禁止清单（**栈驱动，不硬编码 Element Plus**） */
export function componentRulesOf(b: ProjectBaseline): ComponentRules {
    if (!b.frontend.enabled || !isVueFamily(b)) return { allowedPrefixes: [], forbidden: [] };
    const hit = VUE_LIB_PREFIX.find(l => l.re.test(b.frontend.ui));
    if (!hit) return { allowedPrefixes: [], forbidden: [] };      // 认不出的库：宁漏不误杀
    return {
        allowedPrefixes: [hit.prefix],
        forbidden: VUE_LIB_PREFIX.filter(l => l.prefix !== hit.prefix),
    };
}

function componentRuleText(b: ProjectBaseline, rules: ComponentRules): string[] {
    if (rules.allowedPrefixes.length === 0) {
        return ["- 组件库以本项目技术基线为准；不凭记忆引入未在基线中声明的 UI 依赖。"];
    }
    const allowed = rules.allowedPrefixes[0]!;
    const names = rules.forbidden.map(f => f.name).join("、");
    return [
        `- 只允许 ${b.frontend.ui}（标签前缀 \`${allowed}*\`）或原生 HTML；${names ? `禁止 ${names} 等其他组件库标签。` : ""}`,
        `- 组件 props/事件/v-model 必须使用 ${b.frontend.ui} 的真实 API，不凭记忆发明组件或属性。`,
    ];
}

// ---------- 第一条栈：Vue 3 + Element Plus + Vite / Spring Boot 3 + Java 17 / MySQL ----------
export const SPRING_VUE: StackProfile = {
    id: "spring-vue",
    label: "Vue 3 + Element Plus + Vite / Spring Boot 3 + Java 17 + MyBatis-Plus / MySQL 8",
    verified: true,
    match: b => /vue/i.test(b.frontend.framework) && /spring/i.test(b.backend.framework),
    describe: b => `${b.frontend.framework} + ${b.frontend.ui} + ${b.backend.framework}（有验证器）`,
    uiRule: b => {
        const rules = componentRulesOf(b);
        return [
            "",
            "## 技术栈规约（强制，与上文冲突时以本节为准）",
            ...componentRuleText(b, rules),
            `- 业务请求只能 import ${b.frontend.requestPath}；不得另起 services/api.js、utils/request.js 或其他 axios/fetch 封装。`,
            "- 后端 API 前缀由引擎骨架的 `server.servlet.context-path: /api` 承担：Controller 只写**去掉前缀后**的路径（如 `@GetMapping(\"/notes\")`），**绝不要再写 /api**，否则真实 URL 会变成 /api/api/...。",
            "- 后端建表脚本由引擎直出到 `backend/src/main/resources/schema.sql`，并由 `spring.sql.init.mode=always` 在启动时真实执行：业务代码不许自己建库建表、不许硬编码数据库地址/账号/密码（只从 `SPRING_DATASOURCE_*` 环境变量取）。",
            // ★ 9/18 补（实测事故）：s1-crud-min 那两轮，agent 为了"把应用连上库"反复磨
            //   application.yml / 猜 MySQL 凭据（`mysql -u root --skip-password`、翻 `.my.cnf`、
            //   `docker ps`），整整 20 分钟没写业务代码。凭据是**引擎在验证阶段注入**的，
            //   本机连不上库只影响"你自己起服务"这一次尝试，不影响交付，更不该变成探测任务。
            "- **不要探测或猜测数据库凭据**：`SPRING_DATASOURCE_*` 由引擎在验证阶段注入，你不需要知道它的值，也不要把任何值/默认值写进 `application.yml`（只留 `${...}` 占位）。本机起不来应用就如实记「未验证」继续走——**为连库耗掉的每一轮都是在偷业务代码的预算**。",
            "- 颜色/圆角/间距引用 frontend/src/style.css 的 --cf-* 变量；硬编码色值最多 5 处。",
        ].join("\n");
    },
    componentRules: componentRulesOf,
    /**
     * ★ 阶段 1：引擎拥有件扩容到**真骨架**——入口、路由、构建文件、后端启动件、
     *   数据库初始化脚本全部由引擎直出，任务写盘前机械拒绝。
     *   （历史病：p9 全树没有 main.ts/App.vue；s3 前端没有 index.html；后端 app 同名类起不来）
     */
    engineOwnedFiles: [
        "frontend/index.html",
        "frontend/package.json",
        "frontend/vite.config.ts",
        "frontend/tsconfig.json",
        "frontend/src/main.ts",
        "frontend/src/App.vue",
        "frontend/src/router/index.ts",
        "frontend/src/style.css",
        "frontend/src/utils/request.ts",
        "backend/pom.xml",
        "backend/src/main/java/com/crewforge/Application.java",
        "backend/src/main/resources/application.yml",
        "backend/src/main/resources/schema.sql",
    ],
    skeletonFiles: [
        "frontend/index.html", "frontend/package.json", "frontend/vite.config.ts", "frontend/tsconfig.json",
        "frontend/src/main.ts", "frontend/src/App.vue", "frontend/src/router/index.ts", "frontend/src/style.css",
        "frontend/src/utils/request.ts",
        "backend/pom.xml", "backend/src/main/java/com/crewforge/Application.java",
        "backend/src/main/resources/application.yml", "backend/src/main/resources/schema.sql",
    ],
    verify: { compile: "mvnw -B -DskipTests compile", boot: true, testInjection: "http-cases" },
};

/** 兜底档：认不出的栈。允许生成，但**永远标未验证**，且不做任何栈专属承诺 */
export const GENERIC_STACK: StackProfile = {
    id: "generic-unverified",
    label: "未登记技术栈",
    verified: false,
    match: () => true,
    describe: b => `${b.frontend.framework} + ${b.frontend.ui} / ${b.backend.framework}（无验证器：只能"未验证"交付）`,
    uiRule: () => [
        "",
        "## 技术栈规约（强制）",
        "- 本项目技术栈**没有对应验证器**：引擎只能保证语法与静态检查，**不保证可构建/可启动/可测**。",
        "- 严格按技术基线里声明的框架与组件库作答；不凭记忆发明 API、组件或依赖名。",
        "- 颜色/圆角/间距引用项目的样式变量文件，不硬编码色值。",
    ].join("\n"),
    componentRules: () => ({ allowedPrefixes: [], forbidden: [] }),
    engineOwnedFiles: [],
    skeletonFiles: [],
    verify: { compile: "", boot: false, testInjection: "none" },
};

const REGISTRY: StackProfile[] = [SPRING_VUE, GENERIC_STACK];

/** 解析栈描述符：第一个命中的优先，兜底 GENERIC_STACK（**永不返回 null**） */
export function resolveStackProfile(baseline: ProjectBaseline = PROJECT_BASELINE): StackProfile {
    return REGISTRY.find(p => p.match(baseline)) ?? GENERIC_STACK;
}

/** 报告用：把所有已登记栈列出来（含"未验证"标记），供 UI 诚实展示覆盖范围 */
export function listStacks(): { id: string; label: string; verified: boolean }[] {
    return REGISTRY.map(p => ({ id: p.id, label: p.label, verified: p.verified }));
}
