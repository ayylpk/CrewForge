package com.hina.crewforge.common.exception;

import com.hina.crewforge.common.constant.MessageConstant;

/**
 * 未登录/登录失效异常 → 全局异常处理器返回 401
 */
public class UserNotLoginException extends BaseException {

    public UserNotLoginException() {
        super(MessageConstant.NOT_LOGIN);
    }

    public UserNotLoginException(String msg) {
        super(msg);
    }
}
