package com.hina.crewforge.pojo.QueryParam;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class TenantQueryParam {
    private Integer page = 1;
    private Integer pageSize = 10;
    /** 关键词搜索(团队名称) */
    private String tenantName;
}
