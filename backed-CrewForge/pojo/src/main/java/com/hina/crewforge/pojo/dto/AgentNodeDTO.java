package com.hina.crewforge.pojo.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class AgentNodeDTO {
    private Long agentId;
    private String nodeName;
    private String description;
    private String systemPrompt;
    /** 采样温度 (Double 可空, 不传则后端给默认 0.7) */
    private Double temperature;
    private String tools;
    private String model;
}
