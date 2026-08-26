package com.hina.crewforge.pojo.QueryParam;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * 项目 Agent 查询参数
 * ⚠️ 砍掉团队功能后：移除 tenantId
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class ProjectAgentQueryParam {
    private Integer page = 1;
    private Integer pageSize = 10;
    /** 项目ID（查某个项目的 Agent 团队） */
    private Long projectId;
    /** 用户ID（与 projectId 双条件隔离） */
    private Long userId;
}
