package com.hina.crewforge.pojo.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.math.BigDecimal;
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
    /** 系统提示词 */
    private String systemPrompt;
    /** 可用工具列表(JSON数组字符串): ["web_search", "read_file", ...] */
    private String tools;
    /** 模型: claude-sonnet-4-6 / claude-opus-4-8 */
    private String model;
    /** 采样温度 0.0-2.0 */
    private BigDecimal temperature;
    /** 状态: 1-启用, 0-停用 */
    private Integer status;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createTime;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updateTime;
    @TableLogic
    private Integer deleted;
}
