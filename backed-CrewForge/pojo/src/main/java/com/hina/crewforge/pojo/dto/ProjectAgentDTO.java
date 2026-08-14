package com.hina.crewforge.pojo.dto;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class ProjectAgentDTO {
    private Long id;
    /** 项目ID */
    private Long projectId;
    /** 所属用户ID（必传，数据隔离用） */
    private Long userId;
    /** 关联 AgentPool 池 id (sys_agent.id) */
    private Long agentId;
    /** 状态: 1-参与项目, 0-已移出 */
    private Integer status;
}
