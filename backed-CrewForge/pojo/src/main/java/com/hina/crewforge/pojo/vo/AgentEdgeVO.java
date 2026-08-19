package com.hina.crewforge.pojo.vo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.LocalDateTime;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class AgentEdgeVO {
    private Long id;
    private Long agentId;
    private String fromNode;
    private String type;
    private String toNodes;
    private LocalDateTime createTime;
    private LocalDateTime updateTime;
}
