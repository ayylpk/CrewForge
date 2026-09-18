package com.hina.crewforge.common.result;

import lombok.Data;

import java.io.Serializable;

/**
 * 统一响应体
 * @param <T> 数据类型
 */
@Data
public class Result<T> implements Serializable {

    /** 状态码: 1-成功, 0-失败 */
    private Integer code;
    /** 错误信息 */
    private String msg;
    /** 返回数据 */
    private T data;

    public static <T> Result<T> success() {
        Result<T> result = new Result<>();
        result.code = 1;
        return result;
    }

    public static <T> Result<T> success(T object) {
        Result<T> result = new Result<>();
        result.code = 1;
        result.data = object;
        return result;
    }

    public static <T> Result<T> error(String msg) {
        Result<T> result = new Result<>();
        result.code = 0;
        result.msg = msg;
        return result;
    }
}
