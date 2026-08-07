package com.hina.crewforge.handler;

import com.hina.crewforge.common.exception.AccountLockedException;
import com.hina.crewforge.common.exception.AccountNotFoundException;
import com.hina.crewforge.common.exception.BaseException;
import com.hina.crewforge.common.exception.ParamErrorException;
import com.hina.crewforge.common.exception.PasswordErrorException;
import com.hina.crewforge.common.exception.PermissionDeniedException;
import com.hina.crewforge.common.exception.UserNotLoginException;
import com.hina.crewforge.common.result.Result;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * 全局异常处理器 — 每种异常一个「科室」（@ExceptionHandler 方法）
 *
 * 匹配规则: 抛出的异常 → 找最精确的处理器；子类异常能被父类处理器接住（多态）
 * 状态码约定:
 *   401 未登录 / 403 锁定、无权限 / 400 业务参数类错误 / 500 系统兜底
 */
@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    /**
     * 未登录 → 401
     */
    @ExceptionHandler(UserNotLoginException.class)
    @ResponseStatus(HttpStatus.UNAUTHORIZED)
    public Result handleUserNotLoginException(UserNotLoginException e) {
        log.warn("未登录: {}", e.getMessage());
        return Result.error(e.getMessage());
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
     * 权限不足 → 403
     */
    @ExceptionHandler(PermissionDeniedException.class)
    @ResponseStatus(HttpStatus.FORBIDDEN)
    public Result handlePermissionDeniedException(PermissionDeniedException e) {
        log.warn("权限不足: {}", e.getMessage());
        return Result.error(e.getMessage());
    }

    /**
     * 参数错误 → 400
     */
    @ExceptionHandler(ParamErrorException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public Result handleParamErrorException(ParamErrorException e) {
        log.warn("参数错误: {}", e.getMessage());
        return Result.error(e.getMessage());
    }

    /**
     * 其他业务异常（BaseException 的其他子类）→ 400
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
