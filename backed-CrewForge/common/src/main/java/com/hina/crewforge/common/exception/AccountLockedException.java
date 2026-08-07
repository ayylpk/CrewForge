package com.hina.crewforge.common.exception;

import com.hina.crewforge.common.constant.MessageConstant;

/**
 * 账号已锁定异常 → 全局处理器返回 403
 */
public class AccountLockedException extends BaseException {

    public AccountLockedException() {
        super(MessageConstant.ACCOUNT_LOCKED);
    }

    public AccountLockedException(String msg) {
        super(msg);
    }
}
