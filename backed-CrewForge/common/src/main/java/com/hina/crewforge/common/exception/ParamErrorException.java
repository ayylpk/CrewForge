package com.hina.crewforge.common.exception;

import com.hina.crewforge.common.constant.MessageConstant;

/**
 * 参数错误异常 → 全局处理器返回 400
 */
public class ParamErrorException extends BaseException {

    public ParamErrorException() {
        super(MessageConstant.PARAM_ERROR);
    }

    public ParamErrorException(String msg) {
        super(msg);
    }
}
