package com.hina.crewforge.common.constant;

/**
 * 消息常量 — 统一管理返回给前端的提示文本
 *
 * 9/17 清理：删掉 NOT_LOGIN / PERMISSION_DENIED / PARAM_ERROR（它们的唯一读者是三个
 * 从未被 throw 过的异常类）与 OPERATION_SUCCESS / OPERATION_FAILED（零引用）。
 * 剩下的三个都挂在真正会被抛出的异常上（见 exception/ 目录）。
 */
public class MessageConstant {

    public static final String ACCOUNT_NOT_FOUND = "账号不存在";
    public static final String PASSWORD_ERROR = "密码错误";
    public static final String ACCOUNT_LOCKED = "账号已锁定";

}
