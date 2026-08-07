package com.hina.crewforge.common.exception;

import com.hina.crewforge.common.constant.MessageConstant;

/**
 * 密码错误异常 → 全局处理器返回 400
 */
public class PasswordErrorException extends BaseException {

    public PasswordErrorException() {
        super(MessageConstant.PASSWORD_ERROR);
    }

    public PasswordErrorException(String msg) {
        super(msg);
    }
}
