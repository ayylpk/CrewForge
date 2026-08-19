package com.hina.crewforge.pojo.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class AgentEdgeDTO {
    /** 关联池 Agent id（必传） */
    private Long agentId;
    /** 起点节点名（必传；__start__ = 图起点） */
    private String fromNode;
    /** 连接方式: direct / conditional / parallel（不传默认 direct） */
    private String type;
    /** 下一批节点（必传；格式见实体注释） */
    private String toNodes;
}
