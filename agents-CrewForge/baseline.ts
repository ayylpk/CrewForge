/**
 * CrewForge 的单一技术基线。
 *
 * 这份数据同时服务于契约、prompt、地基整形和测试闸门。模型可以补充业务
 * 细节，但不能改变这些基础约束，否则同一项目会出现互相不能编译的产物。
 */
export interface ProjectBaseline {
    frontend: {
        framework: "Vue 3";
        ui: "Element Plus";
        build: "Vite";
        requestPath: "frontend/src/utils/request.ts";
    };
    backend: {
        framework: "Spring Boot 3";
        language: "Java 17";
        orm: "MyBatis-Plus";
    };
    database: "MySQL 8";
    auth: "JWT";
    apiPrefix: "/api";
    response: {
        successCode: 1;
        errorCode: 0;
        messageField: "msg";
    };
}

export const PROJECT_BASELINE: ProjectBaseline = {
    frontend: {
        framework: "Vue 3",
        ui: "Element Plus",
        build: "Vite",
        requestPath: "frontend/src/utils/request.ts",
    },
    backend: {
        framework: "Spring Boot 3",
        language: "Java 17",
        orm: "MyBatis-Plus",
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

export function baselinePromptBlock(): string {
    return [
        "## CrewForge 技术基线（代码闸门强制，不能由模型改写）",
        `- 前端：${PROJECT_BASELINE.frontend.framework} + ${PROJECT_BASELINE.frontend.ui} + ${PROJECT_BASELINE.frontend.build}`,
        `- 后端：${PROJECT_BASELINE.backend.framework}，${PROJECT_BASELINE.backend.language}，${PROJECT_BASELINE.backend.orm}`,
        `- 数据库：${PROJECT_BASELINE.database}`,
        `- 认证：${PROJECT_BASELINE.auth}，前端通过 Authorization 请求头发送 token；禁止 localStorage 之外的伪认证协议`,
        `- API 前缀：${PROJECT_BASELINE.apiPrefix}`,
        `- 响应：{ code, msg, data }；成功 code=${API_SUCCESS_CODE}，失败 code=${API_ERROR_CODE}`,
        `- 请求封装唯一标准路径：${CANONICAL_REQUEST_PATH}；业务文件只能 import 它，不得另起 axios/fetch 封装`,
    ].join("\n");
}
