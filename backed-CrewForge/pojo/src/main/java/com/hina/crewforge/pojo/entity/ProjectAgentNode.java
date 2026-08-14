package com.hina.crewforge.pojo.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 项目成员节点配置 (sys_project_agent_node)
 * 从池拉取成员时把池节点复制一份进来 (复制非引用), 项目内修改不影响池
 * 一个项目成员 (sys_project_agent 行) 对应多个节点, 每节点一套提示词/工具/模型
 */
@Data
@TableName("sys_project_agent_node")
public class ProjectAgentNode {
    @TableId(type = IdType.AUTO)
    private Long id;
    /** 项目ID */
    private Long projectId;
    /** 来源池 Agent id (sys_agent.id, 成员行 agent_id) */
    private Long agentId;
    /** 所属用户ID (数据隔离, 从 JWT 取, 不信任前端) */
    private Long userId;
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
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createTime;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updateTime;
    @TableLogic
    private Integer deleted;
}
