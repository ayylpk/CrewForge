package com.hina.crewforge.pojo.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableLogic;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 任务 (sys_task) —— Agent 引擎与看板的桥（任务为原子铁律的落点）
 *
 * 字段形状以现网表为准（9/2 施工手册 F6）：
 *   - task_id_ext 是引擎 ExecTask.id（如 "T1"/"T2-F"），引擎判定消息只带它，靠它反查本表
 *   - depends_on 是 JSON 列（如 ["T2"]）——Java 按 String 透传，前端 TaskItem.dependsOn 收字符串
 * 时间列交给 DB 默认值/ON UPDATE 维护（本库无 MetaObjectHandler）。
 */
@Data
@TableName("sys_task")
public class Task {
    @TableId(type = IdType.AUTO)
    private Long id;
    /** 项目ID（关联 sys_project.id） */
    private Long projectId;
    /** 阶段ID（planItem.phase，引擎按阶段循环） */
    private Long phaseId;
    /** 任务标题, 如"登录接口 POST /api/auth/login" */
    private String title;
    /** 任务描述（自包含：接口路径/参数/验收标准） */
    private String description;
    /** 状态: todo/doing/done/failed（看板四列） */
    private String status;
    /** 负责人（Agent 角色名, 如"后端开发"） */
    private String assignee;
    /** 分层: backend/frontend */
    private String layer;
    /** 验收标准（从 Plan.features 抄写，验收契约不发明） */
    private String acceptance;
    /** 执行结果（Agent 完成时写入） */
    private String result;
    /** 失败原因（Agent 失败时写入, 前端卡片展开可见） */
    private String errorMsg;
    /** 已重试次数（上限 3, 引擎消费 todo 时带 retry_count<3 护栏） */
    private Integer retryCount;
    /** 外部编号（ExecTask.id, 如 T1/T2-F） */
    private String taskIdExt;
    /** 依赖任务 ext 编号（JSON 列字符串, 如 ["T2"]; 后端任务为 null） */
    private String dependsOn;
    /** 下发排序（看板组内序） */
    private Integer sortOrder;
    private LocalDateTime createTime;
    private LocalDateTime updateTime;
    @TableLogic
    private Integer deleted;
}
