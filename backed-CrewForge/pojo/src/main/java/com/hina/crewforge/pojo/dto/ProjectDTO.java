package com.hina.crewforge.pojo.dto;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class ProjectDTO {
    /** 所属团队ID(个人项目不传) */
    private Long tenantId;
    /** 项目类型: 1-个人项目, 2-团队项目(见 Project.PROJECT_TYPE_*), 不传默认1 */
    private Integer projectType;
    /** 创建人ID(前端传当前登录用户) */
    private Long createUser;
    /** 项目名称 */
    private String name;
    /** 项目描述(原始需求: 这个项目要做什么样子的项目) */
    private String description;
    /** 需求澄清后的结构化文档(Markdown)，项目经理澄清后写入 */
    private String clarifiedReq;
    /** 业务模块/功能列表(JSON 数组字符串)，项目经理确认功能后写入 */
    private String businessModules;
    /** 技术栈方案(JSON 数组字符串)，架构师规划后写入 */
    private String techStack;
    /** 开发计划(JSON 数组字符串)，架构师生成 */
    private String devPlan;
    /** 项目目录树(JSON 数组字符串)，架构师设计 */
    private String dirTree;
    /** 状态: draft/clarifying/planning/executing/paused/done/failed(update 时流转) */
    private String status;
    /** 确认模式: 0-全绿灯, 1-混合, 2-手动(见 Project.CONFIRM_MODE_*) */
    private Integer confirmMode;
}
