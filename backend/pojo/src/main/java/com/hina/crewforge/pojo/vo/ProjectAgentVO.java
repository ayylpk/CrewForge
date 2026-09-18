package com.hina.crewforge.pojo.vo;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import java.time.LocalDateTime;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class ProjectAgentVO {
    private Long id;
    private Long projectId;
    /** 所属用户ID */
    private Long userId;
    /** 关联 AgentPool 池 id (sys_agent.id) */
    private Long agentId;
    /** 池 Agent 名称 (JOIN sys_agent 带出, 池删除后仍保留) */
    private String name;
    /** 职位描述 (JOIN sys_agent 带出) */
    private String role;
    private Integer status;
    private LocalDateTime createTime;
    private LocalDateTime updateTime;
}
