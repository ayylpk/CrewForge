package com.hina.crewforge.pojo.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 自定义 AgentPool 池 (sys_agent)
 * 用户永久自定义保存的 AgentPool 档案, 作为模板源
 * 创建项目团队时从中挑选, 复制到 sys_project_agent
 */
@Data
@TableName("sys_agent")
public class AgentPool {
    @TableId(type = IdType.AUTO)
    private Long id;
    /** 所属用户ID(池按用户隔离) */
    private Long userId;
    /** Agent名称, 如"前端工程师-阿蓝" */
    private String name;
    /** 职位描述, 如"负责Vue前端开发" */
    private String role;
    /** 状态: 1-启用, 0-停用 */
    private Integer status;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createTime;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updateTime;
    @TableLogic
    private Integer deleted;
}
