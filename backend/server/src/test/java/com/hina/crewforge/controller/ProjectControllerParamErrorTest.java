package com.hina.crewforge.controller;

import com.hina.crewforge.handler.GlobalExceptionHandler;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.hamcrest.Matchers.containsString;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 「前端把 id 拼成 NaN」这一类客户端参数错误，必须回 400 + 可读原因，**不许回 500「系统繁忙」**。
 *
 * 这是 9/17 用户实测那个「一直弹系统繁忙」的另一半护栏。
 * 用户侧症状：项目详情页两个 10s 轮询直接 `Number(route.params.id)`，
 * 地址里没有有效项目号时得 NaN → `/api/project/NaN`、`/api/project-run/NaN`。
 * 后端侧根因：MethodArgumentTypeMismatchException 继承自 RuntimeException，
 * 没有被任何精确处理器接住，掉进 GlobalExceptionHandler 最后的 Exception 兜底 → 500。
 *
 * 这里用 MockMvc 的 standaloneSetup 打**真 Spring MVC 的参数转换 + @ControllerAdvice 链路**
 * （不是直接调 handler 方法），所以它证明的是端到端行为；不需要数据库，也不需要 JWT
 * （standaloneSetup 不装 JwtInterceptor——拦截器属配置层，由 WebMvcConfig 注册）。
 */
class ProjectControllerParamErrorTest {

    private MockMvc mvc() {
        // ProjectController 的 service 传 null 即可：参数转换在进入方法体之前就失败了
        return MockMvcBuilders.standaloneSetup(new ProjectController(null))
                .setControllerAdvice(new GlobalExceptionHandler())
                .build();
    }

    @Test
    @DisplayName("GET /api/project/NaN → 400（不是 500），且说清是 id 收到 NaN")
    void nanProjectIdIsBadRequest() throws Exception {
        mvc().perform(get("/api/project/NaN"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.msg").value(containsString("id")))
                .andExpect(jsonPath("$.msg").value(containsString("NaN")));
    }

    @Test
    @DisplayName("ProjectRunController 同样：/api/project-run/NaN → 400")
    void nanProjectRunIdIsBadRequest() throws Exception {
        MockMvc mvc = MockMvcBuilders
                .standaloneSetup(new ProjectRunController(null))
                .setControllerAdvice(new GlobalExceptionHandler())
                .build();
        mvc.perform(get("/api/project-run/NaN"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.msg").value(containsString("NaN")));
    }

    @Test
    @DisplayName("缺必填 query 参数 → 400 并点名参数（ProjectFileController.list 的 projectId）")
    void missingRequiredQueryParamIsBadRequest() throws Exception {
        MockMvc mvc = MockMvcBuilders
                .standaloneSetup(new ProjectFileController(null))
                .setControllerAdvice(new GlobalExceptionHandler())
                .build();
        mvc.perform(get("/api/projectfile/list"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.msg").value(containsString("projectId")));
    }
}
