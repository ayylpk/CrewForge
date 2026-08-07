package com.hina.crewforge.pojo.QueryParam;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class ProjectQueryParam {
    private Integer page = 1;
    private Integer pageSize = 20;
    /** 查询类型: 1-个人项目(按userId), 2-团队项目(需传tenantId) */
    private Integer projectType;
    /** 用户ID(查个人项目时必传, 过滤 create_user) */
    private Long userId;
    /** 团队ID(查团队项目时必传) */
    private Long tenantId;
    /** 关键词搜索(项目名称) */
    private String keyword;
    /** 状态过滤: draft/clarifying/planning/executing/paused/done/failed */
    private String status;
}
