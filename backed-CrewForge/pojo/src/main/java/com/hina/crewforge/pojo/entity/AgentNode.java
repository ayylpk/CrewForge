package com.hina.crewforge.pojo.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * Agent 节点配置 (sys_agent_node)
 * 一个池 Agent (sys_agent) 可配置多个节点, 每个节点一套系统提示词/工具/模型
 */
@Data
@TableName("sys_agent_node")
public class AgentNode {
    @TableId(type = IdType.AUTO)
    private Long id;
    /** 关联 AgentPool 池 id (sys_agent.id) */
    private Long agentId;
    /** 节点名称, 如"规划节点"、"编码节点" */
    private String nodeName;
    /** 节点作用描述 */
    private String description;
    /** 系统提示词 */
    private String systemPrompt;
    /** 采样温度 (Double 可空, 防前端不传被 0.0 覆盖默认值) */
    private Double temperature;
    /** 可用工具列表(JSON数组字符串) */
    private String tools;
    /** 模型 */
    private String model;
    /** 节点类型: llm=调模型 / code=纯代码(按code_key注册) / human=交互门 */
    private String nodeType;
    /** 结构化输出 schema 注册名(仅 llm 节点用, 可空) */
    private String schemaKey;
    /** 代码节点注册名(仅 code 节点用, 对应运行时 CodeRegistry) */
    private String codeKey;
    /** 输出 state 通道名(缺省=node_name; 不能与节点名重名, LangGraph 硬约束) */
    private String output;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createTime;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updateTime;
    @TableLogic
    private Integer deleted;
}
