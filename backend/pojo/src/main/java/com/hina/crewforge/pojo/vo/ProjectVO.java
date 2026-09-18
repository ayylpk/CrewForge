package com.hina.crewforge.pojo.vo;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import java.time.LocalDateTime;

/**
 * 项目返回体
 * ⚠️ 砍掉团队功能后：移除 tenantId / projectType
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class ProjectVO {
    private Long id;
    private String name;
    private String description;
    private String clarifiedReq;
    private String businessModules;
    private String techStack;
    private String devPlan;
    private String dirTree;
    private String status;
    /** 确认模式: 0-全绿灯, 1-混合, 2-手动 */
    private Integer confirmMode;
    private String projectDir;
    /** 整体进度 0-100(暂无任务表, 暂返回0; 待 sys_task 落地后按任务统计) */
    private Integer progress;
    /** 项目文件数(sys_project_file 按 project_id 统计) */
    private Long fileCount;
    /** 业务模块数(businessModules JSON 数组长度) */
    private Integer moduleCount;
    private Long createUser;
    private LocalDateTime createTime;
    private LocalDateTime updateTime;
}
