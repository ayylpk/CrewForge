package com.hina.crewforge.pojo.vo;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import java.math.BigDecimal;
import java.time.LocalDateTime;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class ProjectAgentVO {
    private Long id;
    private Long projectId;
    /** 所属用户ID */
    private Long userId;
    private String name;
    private String role;
    private String systemPrompt;
    private String tools;
    private String model;
    private BigDecimal temperature;
    private Integer status;
    private LocalDateTime createTime;
    private LocalDateTime updateTime;
}
