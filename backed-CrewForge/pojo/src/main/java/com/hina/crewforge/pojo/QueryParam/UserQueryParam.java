package com.hina.crewforge.pojo.QueryParam;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class UserQueryParam {
    private Integer page = 1;
    private Integer pageSize = 10;
    /** 用户名模糊搜索 */
    private String username;
    /** 状态过滤: 1-启用, 0-禁用 */
    private Integer status;
}
