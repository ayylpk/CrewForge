package com.hina.crewforge.pojo.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 项目 (sys_project)
 * 用户创建的 AI 编程项目, 一个项目属于一个团队
 * 包含需求 → 澄清 → 规划 → 执行 全过程的产物快照
 */
@Data
@TableName("sys_project")
public class Project {

    /** 确认模式: 全绿灯(Agent自动执行, 无需人工确认) */
    public static final Integer CONFIRM_MODE_GREEN = 0;
    /** 确认模式: 混合(关键步骤人工确认) */
    public static final Integer CONFIRM_MODE_MIXED = 1;
    /** 确认模式: 手动(每一步人工确认) */
    public static final Integer CONFIRM_MODE_MANUAL = 2;

    /** 项目类型: 个人项目(挂在创建人名下, 不属团队) */
    public static final Integer PROJECT_TYPE_PERSONAL = 1;
    /** 项目类型: 团队项目(属于团队工作区) */
    public static final Integer PROJECT_TYPE_TEAM = 2;

    /** 项目ID */
    @TableId(type = IdType.AUTO)
    private Long id;
    /** 所属团队ID(NULL=个人项目) */
    private Long tenantId;
    /** 项目类型: 1-个人项目, 2-团队项目(见常量 PROJECT_TYPE_*) */
    private Integer projectType;
    /** 项目名称 */
    private String name;
    /** 项目描述(原始需求) */
    private String description;
    /** 需求澄清后的结构化文档 */
    private String clarifiedReq;
    /** AI拆分的业务模块列表(JSON) */
    private String businessModules;
    /** 技术栈方案(JSON) */
    private String techStack;
    /** 开发计划(JSON) */
    private String devPlan;
    /** 项目目录树(JSON) */
    private String dirTree;
    /** 状态: draft(草稿)/clarifying(澄清中)/planning(规划中)/executing(执行中)/paused(已暂停)/done(已完成)/failed(失败) */
    private String status;
    /** 确认模式(见下方常量): 0-全绿灯, 1-混合, 2-手动 */
    private Integer confirmMode;
    /** 服务器上项目文件目录 */
    private String projectDir;
    /** 创建人ID */
    private Long createUser;
    /** 创建时间 */
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createTime;
    /** 最后更新时间 */
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updateTime;
    /** 逻辑删除: 0-未删除, 1-已删除 */
    @TableLogic
    private Integer deleted;
}
