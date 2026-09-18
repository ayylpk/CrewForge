package com.hina.crewforge.pojo.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * 登录请求参数
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class LoginDTO {

    /** 用户名 */
    private String username;

    /** 密码 */
    private String password;
}
