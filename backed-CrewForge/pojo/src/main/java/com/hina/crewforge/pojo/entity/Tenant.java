package com.hina.crewforge.pojo.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 团队 (sys_tenant)
 * 多租户 = 多团队; 每个团队是一个独立的工作空间, 数据完全隔离
 * 项目挂团队(tenant_id), 用户通过 sys_user_tenant 加入团队
 */
@Data
@TableName("sys_tenant")
public class Tenant {
    /** 默认团队人数上限 */
    public static final int DEFAULT_MAX_MEMBERS = 10;
    /** 超出上限的容忍人数 */
    public static final int MAX_MEMBERS_BUFFER = 2;

    @TableId(type = IdType.AUTO)
    private Long id;
    /** 团队名称 */
    private String name;
    /** 团队创建人/管理员ID(联查 sys_user.id) */
    private Long ownerId;
    /** 联系人 */
    private String contact;
    /** 描述 */
    private String description;
    /** 状态: 1-启用, 0-禁用 */
    private Integer status;
    /** 邀请码 */
    private String invitationCode;

    private Integer members;
    /** 团队人数上限（软限制，校验时允许超出 {@link #MAX_MEMBERS_BUFFER} 人） */
    private Integer maxMembers;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createTime;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updateTime;
    @TableLogic
    private Integer deleted;
}
