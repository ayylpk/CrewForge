package com.hina.crewforge.pojo.dto;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class AgentPoolDTO {
    /** 所属用户ID */
    private Long userId;
    /** Agent名称 */
    private String name;
    /** 职位描述 */
    private String role;
    /** 状态: 1-启用, 0-停用 */
    private Integer status;
}
