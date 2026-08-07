package com.hina.crewforge.pojo.QueryParam;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class AgentPoolQueryParam {
    private Integer page = 1;
    private Integer pageSize = 10;
    /** 用户ID（必填，数据隔离） */
    private Long userId;
    /** 关键词搜索（匹配 AgentPool 名称/职位） */
    private String keyword;
}
