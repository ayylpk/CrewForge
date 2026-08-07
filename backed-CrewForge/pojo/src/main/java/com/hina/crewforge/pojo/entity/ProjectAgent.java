package com.hina.crewforge.pojo.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.math.BigDecimal;
import java.time.LocalDateTime;

/**
 * 项目 Agent (sys_project_agent)
 * 创建项目团队时从 sys_agent 池复制一份过来, 每个 Agent 一行
 * 主键 id 即项目内 agent_id, 精准定位用; 同一池 Agent 可复制到多个项目, 互不影响
 */
@Data
@TableName("sys_project_agent")
public class ProjectAgent {
    @TableId(type = IdType.AUTO)
    private Long id;
    /** 项目ID */
    private Long projectId;
    /** 所属用户ID(数据隔离: 查询/新增均按 userId + projectId 双条件) */
    private Long userId;
    /** Agent名称(复制自池) */
    private String name;
    /** 职位描述 */
    private String role;
    /** 系统提示词 */
    private String systemPrompt;
    /** 可用工具列表(JSON数组字符串) */
    private String tools;
    /** 模型 */
    private String model;
    /** 采样温度 0.0-2.0 */
    private BigDecimal temperature;
    /** 状态: 1-参与项目, 0-已移出 */
    private Integer status;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createTime;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updateTime;
    @TableLogic
    private Integer deleted;
}
