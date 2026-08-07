package com.hina.crewforge.pojo.vo;

import lombok.Builder;
import lombok.Data;

import java.util.List;

/**
 * 登录成功返回体
 */
@Data
@Builder
public class LoginVO {

    /** JWT token（只含 userId；前端存 localStorage，请求头 Authorization 携带） */
    private String accessToken;

    /** 用户 ID */
    private Long userId;

    /** 用户名 */
    private String username;

    /** 真实姓名 */
    private String realName;

}
