package com.hina.crewforge.pojo.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

@Data
@TableName("sys_user")
public class User {
    /** 用户ID */
    @TableId(type = IdType.AUTO)
    private Long id;
    // 用户独立于团队，通过 createUser 关联项目
    /** 登录用户名（唯一） */
    private String username;
    /** 密码（BCrypt 加密存储，不存明文） */
    private String password;
    /** 真实姓名 */
    private String realName;
    /** 邮箱 */
    private String email;
    /** 手机号 */
    private String phone;
    /** 状态: 1-启用, 0-禁用 */
    private Integer status;
    /** 创建时间 */
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createTime;
    /** 最后更新时间 */
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updateTime;
    /** 逻辑删除: 0-未删除, 1-已删除 */
    @TableLogic
    private Integer deleted;
}
