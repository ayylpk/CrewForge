import { PROJECT_BASELINE, baselinePromptBlock, resolveProjectBaseline } from "./baseline";

let pass = 0;
let fail = 0;
function ok(condition: boolean, message: string): void {
    if (condition) {
        pass++;
        console.log(`  ✓ ${message}`);
    } else {
        fail++;
        console.log(`  ✗ ${message}`);
    }
}

const fallback = resolveProjectBaseline(null);
ok(fallback.frontend.framework === "Vue 3", "无选型时回退 Vue 3");
ok(fallback.frontend.ui === "Element Plus", "无选型时回退 Element Plus");
ok(fallback.backend.framework === "Spring Boot 3", "无选型时回退 Spring Boot 3");
ok(fallback.database === "MySQL 8", "无选型时回退 MySQL 8");

const selected = resolveProjectBaseline({
    techniques: {
        frontend: { framework: "React 19", ui: "Ant Design", build: "Vite" },
        backend: { framework: "FastAPI", language: "Python 3.12", orm: "SQLAlchemy" },
        database: { type: "PostgreSQL 16", why: "关系数据与 JSONB" },
    },
});
ok(selected.frontend.framework === "React 19", "架构输出覆盖前端框架");
ok(selected.frontend.ui === "Ant Design", "架构输出覆盖前端组件库");
ok(selected.backend.framework === "FastAPI", "架构输出覆盖后端框架");
ok(selected.backend.language === "Python 3.12", "架构输出覆盖后端语言");
ok(selected.database === "PostgreSQL 16", "架构输出覆盖数据库");
ok(selected.auth === "JWT", "平台认证协议默认保持 JWT");
ok(selected.apiPrefix === "/api", "平台 API 前缀默认保持 /api");
ok(baselinePromptBlock(selected).includes("React 19"), "动态 prompt 注入最终前端栈");
ok(baselinePromptBlock(selected).includes("FastAPI"), "动态 prompt 注入最终后端栈");
ok(baselinePromptBlock(selected).includes("PostgreSQL 16"), "动态 prompt 注入最终数据库");
ok(PROJECT_BASELINE.frontend.framework === "Vue 3", "默认基线仍可供兼容调用方使用");

console.log(`\n=== 汇总：${pass} 绿 / ${fail} 红 ===`);
process.exit(fail > 0 ? 1 : 0);
