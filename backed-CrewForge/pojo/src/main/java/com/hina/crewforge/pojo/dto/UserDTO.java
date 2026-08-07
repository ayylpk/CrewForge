package com.hina.crewforge.pojo.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * 用户新增/修改请求
 * 说明: 用户-团队是多对多(见 sys_user_tenant)，不再有单个 tenantId；
 *       创建用户时通过 teamId 加入一个团队，roleId 分配一个角色
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

    /** 加入的团队 ID（可选，不传则创建后不加入任何团队，后续再关联） */
    private Long teamId;

    /** 角色 ID（可选，默认 3=viewer） */
    private Long roleId;
}
