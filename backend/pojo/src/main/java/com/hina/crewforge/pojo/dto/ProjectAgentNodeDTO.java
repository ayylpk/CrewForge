package com.hina.crewforge.pojo.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class ProjectAgentNodeDTO {
    /** 项目ID */
    private Long projectId;
    /** 来源池 Agent id (sys_agent.id) */
    private Long agentId;
    /** 节点名称 */
    private String nodeName;
    /** 节点作用描述 */
    private String description;
    /** 系统提示词 */
    private String systemPrompt;
    /** 采样温度 (Double 可空, 不传则后端给默认 0.7) */
    private Double temperature;
    /** 工具列表(JSON数组字符串) */
    private String tools;
    /** 模型 */
    private String model;
    /** 节点类型: llm/code/human */
    private String nodeType;
    /** 结构化输出 schema 注册名 */
    private String schemaKey;
    /** 代码节点注册名 */
    private String codeKey;
    /** 输出 state 通道名 */
    private String output;
}
