package com.hina.crewforge.controller;

import com.hina.crewforge.common.result.Result;
import com.hina.crewforge.pojo.dto.TaskStatusDTO;
import com.hina.crewforge.pojo.entity.Task;
import com.hina.crewforge.service.TaskService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/**
 * 任务接口（sys_task 桥）——路径与出入参严格对齐前端 api/task.ts：
 *   GET  /api/task/list?projectId=&status=   fetchTasks / fetchTasksByStatus
 *   GET  /api/task/{id}                      fetchTaskById
 *   PUT  /api/task/{id}/status {status,errorMsg}  updateTaskStatus
 *   POST /api/task/{id}/retry                retryTask
 *   POST /api/task                           createTask
 * JWT 由拦截器全局校验；所有权由 TaskService→ProjectGuard 校验（B3 教训不外溢：新域第一天就带锁）。
 * 返回体直接用 Task 实体（驼峰序列化即前端 TaskItem；deleted 字段多传无害）。
 */
@Tag(name = "Task")
@RestController
@RequestMapping("/api/task")
@RequiredArgsConstructor
@Slf4j
public class TaskController {

    private final TaskService taskService;

    @Operation(summary = "项目任务列表（看板轮询, status 可选过滤, 按 sort_order）")
    @GetMapping("/list")
    public Result<List<Task>> list(@RequestParam Long projectId,
                                   @RequestParam(required = false) String status) {
        return Result.success(taskService.listByProject(projectId, status));
    }

    @Operation(summary = "查询单个任务（含 result/errorMsg 全文）")
    @GetMapping("/{id}")
    public Result<Task> getById(@PathVariable Long id) {
        return Result.success(taskService.getTask(id));
    }

    @Operation(summary = "更新任务状态（看板拖拽/引擎推进）")
    @PutMapping("/{id}/status")
    public Result<Void> updateStatus(@PathVariable Long id, @RequestBody TaskStatusDTO dto) {
        log.info("更新任务状态 id={} → {}", id, dto.getStatus());
        taskService.updateStatus(id, dto);
        return Result.success();
    }

    @Operation(summary = "重跑任务（todo 复位 + retry_count+1, 引擎下轮消费）")
    @PostMapping("/{id}/retry")
    public Result<Void> retry(@PathVariable Long id) {
        log.info("重跑任务 id={}", id);
        taskService.retry(id);
        return Result.success();
    }

    @Operation(summary = "创建任务（status/计数服务端兜底）")
    @PostMapping
    public Result<Long> create(@RequestBody Task task) {
        log.info("创建任务:{}", task.getTitle());
        return Result.success(taskService.createTask(task));
    }
}
