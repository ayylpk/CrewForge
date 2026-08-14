package com.hina.crewforge.pojo.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 项目 Agent (sys_project_agent)
 * 创建项目团队时从 sys_agent 池挑选, 每个 Agent 一行
 * 主键 id 即项目内 agent_id, 精准定位用; 同一池 Agent 可加入多个项目, 互不影响
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
    /** 关联 AgentPool 池 id (sys_agent.id) */
    private Long agentId;
    /** 状态: 1-参与项目, 0-已移出 */
    private Integer status;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createTime;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updateTime;
    @TableLogic
    private Integer deleted;
}
