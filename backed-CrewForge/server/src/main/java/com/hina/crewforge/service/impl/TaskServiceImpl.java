package com.hina.crewforge.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import com.hina.crewforge.common.exception.BaseException;
import com.hina.crewforge.mapper.TaskMapper;
import com.hina.crewforge.pojo.dto.TaskStatusDTO;
import com.hina.crewforge.pojo.entity.Project;
import com.hina.crewforge.pojo.entity.Task;
import com.hina.crewforge.service.TaskService;
import com.hina.crewforge.service.support.ProjectGuard;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.List;
import java.util.Set;

/**
 * 任务服务实现——sys_task 桥的 Java 侧。
 * 语义镜像引擎 task.ts（前端看板与引擎写同一张表，谁都不例外）：
 *   retry = todo + 清 result/error_msg + retry_count+1；列表恒按 sort_order。
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class TaskServiceImpl extends ServiceImpl<TaskMapper, Task> implements TaskService {

    /** 状态合法值（与引擎 TaskStatus 联合类型一致，防脏状态落库） */
    private static final Set<String> VALID_STATUS = Set.of("todo", "doing", "done", "failed");

    private final ProjectGuard projectGuard;

    @Override
    public List<Task> listByProject(Long projectId, String status) {
        // 列表是看板轮询入口，每次过所有权（成本=一次主键查，换来越权零暴露）
        projectGuard.requireOwned(projectId);
        if (StringUtils.hasText(status) && !VALID_STATUS.contains(status)) {
            throw new BaseException("非法任务状态: " + status);
        }
        LambdaQueryWrapper<Task> wrapper = new LambdaQueryWrapper<>();
        wrapper.eq(Task::getProjectId, projectId)
                .eq(StringUtils.hasText(status), Task::getStatus, status)
                .orderByAsc(Task::getSortOrder);
        return list(wrapper);
    }

    @Override
    public Task getTask(Long id) {
        Task task = requireTaskWithOwnership(id);
        return task;
    }

    @Override
    public void updateStatus(Long id, TaskStatusDTO dto) {
        requireTaskWithOwnership(id);
        String status = dto == null ? null : dto.getStatus();
        if (!StringUtils.hasText(status) || !VALID_STATUS.contains(status)) {
            throw new BaseException("非法任务状态: " + status);
        }
        LambdaUpdateWrapper<Task> update = new LambdaUpdateWrapper<>();
        update.eq(Task::getId, id).set(Task::getStatus, status);
        // errorMsg 传了才写（看板拖拽不带它，引擎失败带它）
        if (dto.getErrorMsg() != null) {
            update.set(Task::getErrorMsg, dto.getErrorMsg());
        }
        // update_time 由 DB ON UPDATE CURRENT_TIMESTAMP 自动维护
        update(update);
        log.info("任务状态更新 id={} → {}（{}）", id, status, dto != null && dto.getErrorMsg() != null ? "含失败原因" : "");
    }

    @Override
    public void retry(Long id) {
        requireTaskWithOwnership(id);
        // 镜像引擎 task.ts retryTask：todo + 清结果/错误 + retry_count+1
        // （set null 必须走 Wrapper——updateById 的 NOT_NULL 策略会把 null 字段跳过）
        LambdaUpdateWrapper<Task> update = new LambdaUpdateWrapper<>();
        update.eq(Task::getId, id)
                .set(Task::getStatus, "todo")
                .set(Task::getResult, null)
                .set(Task::getErrorMsg, null)
                .setSql("retry_count = retry_count + 1");
        update(update);
        log.info("任务重跑 id={}（retry_count+1, 回到 todo）", id);
    }

    @Override
    public Long createTask(Task task) {
        if (task == null || !StringUtils.hasText(task.getTitle())) {
            throw new BaseException("任务 title 不能为空");
        }
        Project project = projectGuard.requireOwned(task.getProjectId());
        // 服务端兜底：不信任 body 里的状态/计数
        if (!StringUtils.hasText(task.getStatus()) || !VALID_STATUS.contains(task.getStatus())) {
            task.setStatus("todo");
        }
        task.setRetryCount(0);
        task.setId(null);
        task.setDeleted(0);
        if (task.getSortOrder() == null) {
            task.setSortOrder(0);
        }
        save(task);
        log.info("任务创建 id={} ext={} 「{}」→ 项目 {}", task.getId(), task.getTaskIdExt(), task.getTitle(), project.getId());
        return task.getId();
    }

    /** 取任务 + 顺藤校验所属项目归当前用户（两检合一，返回实体复用） */
    private Task requireTaskWithOwnership(Long id) {
        Task task = getById(id);
        if (task == null) {
            throw new BaseException("任务不存在: " + id);
        }
        projectGuard.requireOwned(task.getProjectId());
        return task;
    }
}
