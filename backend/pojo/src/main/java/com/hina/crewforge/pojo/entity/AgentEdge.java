package com.hina.crewforge.pojo.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * Agent 图连接声明 (sys_agent_edge)
 * 一个池 Agent (sys_agent) 的节点连线：from_node → type → to_nodes
 * 设计原则：节点干什么由代码决定（CodeRegistry），节点怎么连由 DB 决定
 */
@Data
@TableName("sys_agent_edge")
public class AgentEdge {
    @TableId(type = IdType.AUTO)
    private Long id;
    /** 关联 AgentPool 池 id (sys_agent.id) */
    private Long agentId;
    /** 起点节点名（须存在于 sys_agent_node.node_name；__start__ = 图起点） */
    private String fromNode;
    /** 连接方式: direct=普通边 / conditional=条件边 / parallel=并行分支 */
    private String type;
    /** 下一批节点(字符串):
     *  direct → 单个节点名（如 "finish"）
     *  conditional → JSON {"cond":"条件key","true":"节点","false":"节点"}
     *  parallel → JSON 数组 ["节点A","节点B"] */
    private String toNodes;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createTime;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updateTime;
    @TableLogic
    private Integer deleted;
}
