package com.hina.crewforge.pojo.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 用户-团队关联表（多对多）
 * 一个用户可加入多个团队; status 表示成员关系状态
 * 加入团队须先申请(sys_tenant_apply), 管理员同意后写入本表
 */
@Data
@TableName("sys_user_tenant")
public class UserTenant {

    @TableId(type = IdType.AUTO)
    private Long id;

    /** 用户 ID */
    private Long userId;

    /** 团队 ID */
    private Long tenantId;

    /** 状态: 1-正常成员, 0-已退出/已移除 2-申请中*/
    private Integer status;

    /** 加入时间 */
    private LocalDateTime createTime;
}
