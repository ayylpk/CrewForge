package com.hina.crewforge.pojo.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 团队加入申请 (sys_tenant_apply)
 * 用户凭邀请码申请加入团队 → 管理员同意后才写入 sys_user_tenant(正式成为成员)
 */
@Data
@TableName("sys_tenant_apply")
public class TenantApply {
    @TableId(type = IdType.AUTO)
    private Long id;
    /** 申请加入的团队ID */
    private Long tenantId;
    /** 申请人ID */
    private Long userId;
    /** 填写的邀请码(校验用) */
    private String invitationCode;
    /** 状态: 0-待审核, 1-已同意, 2-已拒绝 */
    private Integer status;
    /** 申请留言 */
    private String applyMsg;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createTime;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updateTime;
    @TableLogic
    private Integer deleted;
}
