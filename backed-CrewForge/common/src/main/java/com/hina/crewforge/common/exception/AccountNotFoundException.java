package com.hina.crewforge.common.exception;

import com.hina.crewforge.common.constant.MessageConstant;

/**
 * 账号不存在异常 → 全局处理器返回 400
 */
public class AccountNotFoundException extends BaseException {

    public AccountNotFoundException() {
        super(MessageConstant.ACCOUNT_NOT_FOUND);
    }

    public AccountNotFoundException(String msg) {
        super(msg);
    }
}
