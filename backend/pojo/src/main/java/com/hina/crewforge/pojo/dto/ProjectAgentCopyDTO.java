package com.hina.crewforge.pojo.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class ProjectAgentCopyDTO {
    /** 目标项目ID */
    private Long projectId;
    /** 所属用户ID */
    private Long userId;
    /** 池 Agent ids（从 sys_agent 复制到 sys_project_agent，复制非引用） */
    private List<Long> agentIds;
}
