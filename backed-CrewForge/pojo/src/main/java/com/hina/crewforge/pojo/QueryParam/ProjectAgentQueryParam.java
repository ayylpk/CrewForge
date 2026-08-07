package com.hina.crewforge.pojo.QueryParam;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class ProjectAgentQueryParam {
    private Integer page = 1;
    private Integer pageSize = 10;
    /** 租户ID（必填，数据隔离） */
    private Long tenantId;
    /** 项目ID（查某个项目的 Agent 团队） */
    private Long projectId;
    /** 用户ID（与 projectId 双条件隔离） */
    private Long userId;
    /** 关键词搜索（匹配 Agent 名称/职位） */
    private String keyword;
}
