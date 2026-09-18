import {
    API_SUCCESS_CODE,
    CANONICAL_REQUEST_PATH,
    PROJECT_BASELINE,
    baselinePromptBlock,
    type ProjectBaseline,
} from "./baseline";

function ok(condition: unknown, message: string): void {
    if (!condition) throw new Error(`FAIL: ${message}`);
    console.log(`  ✓ ${message}`);
}

const baseline: ProjectBaseline = PROJECT_BASELINE;
ok(baseline.frontend.framework === "Vue 3", "前端框架固定 Vue 3");
ok(baseline.frontend.ui === "Element Plus", "前端组件库固定 Element Plus");
ok(baseline.backend.framework === "Spring Boot 3", "后端框架固定 Spring Boot 3");
ok(baseline.database === "MySQL 8", "数据库固定 MySQL 8");
ok(baseline.auth === "JWT", "认证方式固定 JWT");
ok(baseline.apiPrefix === "/api", "API 前缀固定 /api");
ok(CANONICAL_REQUEST_PATH === "frontend/src/utils/request.ts", "请求封装只有一个标准路径");
ok(API_SUCCESS_CODE === 1, "统一成功码为 1");
ok(baselinePromptBlock().includes("Element Plus"), "基线 prompt 包含 Element Plus");
ok(baselinePromptBlock().includes("Spring Boot 3"), "基线 prompt 包含 Spring Boot 3");
ok(baselinePromptBlock().includes("JWT"), "基线 prompt 包含 JWT");

console.log("\n=== 汇总：11 绿 / 0 红 ===");
