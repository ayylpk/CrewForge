package com.hina.crewforge.pojo.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 项目文件 (sys_project_file)
 * Agent 生成的每一个文件存一条记录
 * 同一项目内 file_path 唯一; 列表查询不返回 file_content(太大), 详情接口才返回
 */
@Data
@TableName("sys_project_file")
public class ProjectFile {
    @TableId(type = IdType.AUTO)
    private Long id;
    /** 项目ID */
    private Long projectId;
    /** 文件相对路径, 如 src/main/java/com/hina/.../UserController.java */
    private String filePath;
    /** 文件内容(列表查询不返回, 详情接口才返回) */
    private String fileContent;
    /** 文件类型: java/vue/ts/yml/xml/sql/md/other */
    private String fileType;
    /** 用户是否修改过: 0-未修改, 1-已修改(Agent不覆盖用户的改动) */
    private Integer userModified;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createTime;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updateTime;
    @TableLogic
    private Integer deleted;
}
