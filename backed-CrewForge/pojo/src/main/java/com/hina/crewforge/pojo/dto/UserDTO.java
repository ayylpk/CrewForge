package com.hina.crewforge.pojo.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * 用户新增/修改请求
 * ⚠️ 砍掉团队功能后：移除 teamId；砍掉 RBAC 后：移除 roleId
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class UserDTO {

    /** 用户名（登录账号） */
    private String username;

    /** 密码（创建时必传，修改时为空表示不修改） */
    private String password;

    /** 真实姓名 */
    private String realName;

    /** 邮箱 */
    private String email;

    /** 手机号 */
    private String phone;

    /** 状态: 1-启用, 0-禁用 */
    private Integer status;
}
