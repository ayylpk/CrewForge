package com.hina.crewforge.service;

import com.baomidou.mybatisplus.extension.service.IService;
import com.hina.crewforge.pojo.dto.TaskStatusDTO;
import com.hina.crewforge.pojo.entity.Task;

import java.util.List;

/**
 * 任务服务（sys_task）——端点语义严格对齐前端 api/task.ts 五函数；
 * 全部方法先过 ProjectGuard（存在性 + 所有权），与引擎 task.ts 的 CRUD 语义一一镜像。
 */
public interface TaskService extends IService<Task> {

    /** 项目任务列表（status 可选过滤），按 sort_order 升序 */
    List<Task> listByProject(Long projectId, String status);

    /** 单任务（校验所属项目归当前用户） */
    Task getTask(Long id);

    /** 更新状态（看板拖拽/引擎推进）；errorMsg 传了才写 */
    void updateStatus(Long id, TaskStatusDTO dto);

    /** 重跑：status=todo、清 result/error_msg、retry_count+1（镜像引擎 retryTask SQL） */
    void retry(Long id);

    /** 建任务：status/retry_count 服务端兜底，不信任 body */
    Long createTask(Task task);
}
