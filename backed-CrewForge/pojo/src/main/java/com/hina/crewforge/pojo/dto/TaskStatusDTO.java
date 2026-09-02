package com.hina.crewforge.pojo.dto;

import lombok.Data;

/**
 * 看板状态更新入参（PUT /api/task/{id}/status）
 * 与前端 api/task.ts updateTaskStatus 的 body { status, errorMsg } 对齐。
 */
@Data
public class TaskStatusDTO {
    /** 目标状态: todo/doing/done/failed */
    private String status;
    /** 失败原因（status=failed 时带上; 可选） */
    private String errorMsg;
}
