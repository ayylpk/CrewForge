package com.hina.crewforge.pojo.QueryParam;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * 项目分页查询参数
 * ⚠️ 砍掉团队功能后：移除 projectType / tenantId，按 createUser 过滤
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class ProjectQueryParam {
    private Integer page = 1;
    private Integer pageSize = 20;
    /** 关键词搜索(项目名称) */
    private String keyword;
    /** 状态过滤: draft/clarifying/planning/executing/paused/done/failed */
    private String status;
}
