package com.hina.crewforge.pojo.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

@Data
@TableName("sys_project_version")
public class ProjectVersion {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long projectId;
    private String version;
    private String snapshot;
    private String changeLog;
    private String triggerBy;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createTime;
    @TableLogic
    private Integer deleted;
}
