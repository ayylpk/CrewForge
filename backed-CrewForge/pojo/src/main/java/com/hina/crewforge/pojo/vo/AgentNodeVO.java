package com.hina.crewforge.pojo.vo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.LocalDateTime;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class AgentNodeVO {
    private Long id;
    private Long agentId;
    private String nodeName;
    private String description;
    private String systemPrompt;
    private Double temperature;
    private String tools;
    private String model;
    private LocalDateTime createTime;
    private LocalDateTime updateTime;
}
