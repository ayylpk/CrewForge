package com.hina.crewforge.common.exception;

import com.hina.crewforge.common.constant.MessageConstant;

/**
 * 权限不足异常 → 全局处理器返回 403
 */
public class PermissionDeniedException extends BaseException {

    public PermissionDeniedException() {
        super(MessageConstant.PERMISSION_DENIED);
    }

    public PermissionDeniedException(String msg) {
        super(msg);
    }
}
