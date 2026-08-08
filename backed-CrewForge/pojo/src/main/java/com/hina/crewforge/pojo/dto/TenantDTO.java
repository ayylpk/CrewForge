package com.hina.crewforge.pojo.dto;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class TenantDTO {
    private String name;
    private String contact;
    /** 团队描述 */
    private String description;
    /** 容量上限（创建时设置，默认 DEFAULT_MAX_MEMBERS） */
    private Integer maxMembers;
    private Integer status;
}
