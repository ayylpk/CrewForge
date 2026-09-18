package com.hina.crewforge.handler;

import com.hina.crewforge.common.result.Result;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

import java.lang.reflect.Method;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 「客户端参数错误必须是 400，不能是 500 系统繁忙」的护栏测试。
 *
 * 背景（9/17 实测）：前端 `Number(route.params.id)` 在地址没有有效项目号时得 NaN，
 * 拼进路径就是 /api/project/NaN。Spring 抛 MethodArgumentTypeMismatchException，
 * 而它继承自 RuntimeException，原来一路掉进 GlobalExceptionHandler 最后的
 * `@ExceptionHandler(Exception.class)` 兜底 → **500「系统繁忙，请稍后再试」**。
 * 结果是：调用方自己的参数 bug 被伪装成服务端故障，用户在 10s 轮询下被反复弹窗，
 * 排障时还以为是后端挂了。这三个处理器就是让这类异常停在 400 并说清原因。
 *
 * 纯单元测试，不起 Spring 上下文、不碰数据库。
 */
class GlobalExceptionHandlerTest {

    private final GlobalExceptionHandler handler = new GlobalExceptionHandler();

    @Test
    @DisplayName("路径/参数类型不对（NaN）→ 400 且点明参数名与实收值，不报系统繁忙")
    void typeMismatchIsClientErrorNotServerBusy() throws Exception {
        MethodArgumentTypeMismatchException ex = new MethodArgumentTypeMismatchException(
                "NaN", Long.class, "id", null,
                new NumberFormatException("For input string: \"NaN\""));
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/project/NaN");

        Result<?> result = handler.handleTypeMismatch(ex, request);

        assertEquals(0, result.getCode(), "code=0 表示失败信封（与前端拦截器口径一致）");
        assertNotNull(result.getMsg());
        assertTrue(result.getMsg().contains("id"), "必须点出是哪个参数: " + result.getMsg());
        assertTrue(result.getMsg().contains("NaN"), "必须回显收到的值: " + result.getMsg());
        assertTrue(result.getMsg().contains("Long"), "必须说明需要什么类型: " + result.getMsg());
    }

    @Test
    @DisplayName("处理器的返回状态码注解必须是 400（防止有人改回 500）")
    void typeMismatchIsAnnotatedBadRequest() throws Exception {
        Method m = GlobalExceptionHandler.class.getMethod(
                "handleTypeMismatch", MethodArgumentTypeMismatchException.class,
                jakarta.servlet.http.HttpServletRequest.class);

        // ⚠️ 必须用 AnnotationUtils 取，不能用 m.getAnnotation(ResponseStatus.class)：
        //    @ResponseStatus 的 code() 是 value() 的 @AliasFor 别名，而两个属性的默认值都是
        //    INTERNAL_SERVER_ERROR(500)。裸反射**不做别名合成**，读 code() 会拿到默认的 500，
        //    于是测试会冤枉一个本来写对了的处理器（本测试首跑就是这么红的）。
        //    Spring 运行时走的就是 AnnotationUtils 这条会合成别名的路。
        org.springframework.web.bind.annotation.ResponseStatus status =
                org.springframework.core.annotation.AnnotationUtils.findAnnotation(
                        m, org.springframework.web.bind.annotation.ResponseStatus.class);
        assertNotNull(status, "handleTypeMismatch 必须带 @ResponseStatus");
        assertEquals(400, status.value().value(), "参数类型错误必须是 400");
        assertEquals(400, status.code().value(), "别名合成后 code() 也必须是 400");
    }

    @Test
    @DisplayName("缺少必填 query 参数 → 400 且报出参数名")
    void missingParamIsClientError() {
        MissingServletRequestParameterException ex =
                new MissingServletRequestParameterException("projectId", "Long");
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/task/list");

        Result<?> result = handler.handleMissingParam(ex, request);

        assertEquals(0, result.getCode());
        assertTrue(result.getMsg().contains("projectId"), "必须点出缺了哪个参数: " + result.getMsg());
    }

    @Test
    @DisplayName("请求体不是合法 JSON → 400，且与系统繁忙区分开")
    void unreadableBodyIsClientError() {
        org.springframework.http.converter.HttpMessageNotReadableException ex =
                new org.springframework.http.converter.HttpMessageNotReadableException(
                        "bad json", new com.fasterxml.jackson.core.JsonParseException(null, "boom"));
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/project");

        Result<?> result = handler.handleNotReadableBody(ex, request);

        assertEquals(0, result.getCode());
        assertNotNull(result.getMsg());
        assertTrue(result.getMsg().contains("JSON"), "提示要说清是 JSON 的问题: " + result.getMsg());
    }
}
