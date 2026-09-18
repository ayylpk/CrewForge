package com.hina.crewforge.handler;

import com.hina.crewforge.common.exception.AccountLockedException;
import com.hina.crewforge.common.exception.AccountNotFoundException;
import com.hina.crewforge.common.exception.BaseException;
import com.hina.crewforge.common.exception.PasswordErrorException;
import com.hina.crewforge.common.result.Result;
import jakarta.servlet.http.HttpServletRequest;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

/**
 * 全局异常处理器 — 每种异常一个「科室」（@ExceptionHandler 方法）
 *
 * 匹配规则: 抛出的异常 → 找最精确的处理器；子类异常能被父类处理器接住（多态）
 * 状态码约定:
 *   401 未登录 / 403 锁定、无权限 / 400 业务参数类错误 / 500 系统兜底
 *
 * ⚠️ 9/17 补的三个「客户端输入错误」处理器（typeMismatch / missingParam / notReadableBody）：
 *   这三类异常都继承自 RuntimeException，原来一路掉进最后的兜底 handleException，
 *   于是「前端把 id 拼成了 NaN」这种**调用方自己的参数错误**被报成
 *   `500 系统繁忙，请稍后再试` —— 既骗了用户（服务端其实没坏），也让排障找不到方向。
 *   它们必须停在 400，并且把「哪个参数、收到什么」说清楚。
 */
@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    /**
     * 参数类型不对（如 /api/project/NaN）→ 400
     *
     * 实战来源：前端 `Number(route.params.id)` 在地址没有有效项目号时得 NaN，
     * 拼进路径就是 /api/project/NaN，Spring 转 Long 抛本异常。
     * 这与「系统繁忙」毫无关系，必须如实告诉调用方。
     */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public Result handleTypeMismatch(MethodArgumentTypeMismatchException e, HttpServletRequest request) {
        String got = String.valueOf(e.getValue());
        String need = e.getRequiredType() == null ? "?" : e.getRequiredType().getSimpleName();
        log.warn("参数类型错误: {} {} —— 参数 [{}] 收到 \"{}\"，需要 {}",
                request.getMethod(), request.getRequestURI(), e.getName(), got, need);
        return Result.error("参数 " + e.getName() + " 需要是" + need + "，收到 \"" + got + "\"");
    }

    /**
     * 缺少必填 query 参数 → 400
     */
    @ExceptionHandler(MissingServletRequestParameterException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public Result handleMissingParam(MissingServletRequestParameterException e, HttpServletRequest request) {
        log.warn("缺少必填参数: {} {} —— [{}]（需要 {}）",
                request.getMethod(), request.getRequestURI(), e.getParameterName(), e.getParameterType());
        return Result.error("缺少必填参数: " + e.getParameterName());
    }

    /**
     * 请求体不是合法 JSON（或字段类型对不上）→ 400
     */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public Result handleNotReadableBody(HttpMessageNotReadableException e, HttpServletRequest request) {
        log.warn("请求体无法解析: {} {} —— {}",
                request.getMethod(), request.getRequestURI(), e.getMostSpecificCause().getMessage());
        return Result.error("请求体不是合法 JSON 或字段类型不匹配");
    }

    /**
     * 账号不存在 → 400
     */
    @ExceptionHandler(AccountNotFoundException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public Result handleAccountNotFoundException(AccountNotFoundException e) {
        log.warn("账号不存在: {}", e.getMessage());
        return Result.error(e.getMessage());
    }

    /**
     * 密码错误 → 400
     */
    @ExceptionHandler(PasswordErrorException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public Result handlePasswordErrorException(PasswordErrorException e) {
        log.warn("密码错误: {}", e.getMessage());
        return Result.error(e.getMessage());
    }

    /**
     * 账号锁定 → 403
     */
    @ExceptionHandler(AccountLockedException.class)
    @ResponseStatus(HttpStatus.FORBIDDEN)
    public Result handleAccountLockedException(AccountLockedException e) {
        log.warn("账号锁定: {}", e.getMessage());
        return Result.error(e.getMessage());
    }

    /**
     * 其他业务异常（BaseException 的其他子类）→ 400
     *
     * 9/17 删掉了三个"永远接不到东西"的处理器：
     *   UserNotLoginException / PermissionDeniedException / ParamErrorException ——
     *   全仓没有任何一处 `throw` 它们（未登录的 401 由 JwtInterceptor 直接写响应体，
     *   权限拒绝走 AdminGuard/ProjectGuard 抛的 BaseException）。异常类和处理器一并删除，
     *   免得留下"看着像有这条防线、其实不存在"的假象。
     */
    @ExceptionHandler(BaseException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public Result handleBaseException(BaseException e) {
        log.warn("业务异常: {}", e.getMessage());
        return Result.error(e.getMessage());
    }

    /**
     * 兜底 → 500
     */
    @ExceptionHandler(Exception.class)
    @ResponseStatus(HttpStatus.INTERNAL_SERVER_ERROR)
    public Result handleException(Exception e) {
        log.error("系统异常", e);
        return Result.error("系统繁忙，请稍后再试");
    }
}
