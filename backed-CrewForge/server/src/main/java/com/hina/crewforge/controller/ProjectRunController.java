package com.hina.crewforge.controller;

import com.hina.crewforge.common.result.Result;
import com.hina.crewforge.service.ProjectRunService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@Tag(name = "项目运行（沙箱进程管理）")
@RestController
@RequestMapping("/api/project-run")
@RequiredArgsConstructor
@Slf4j
public class ProjectRunController {

    private final ProjectRunService projectRunService;

    @Operation(summary = "启动项目（spawn 一个进程）")
    @PostMapping("/{projectId}")
    public Result<Void> start(@PathVariable Long projectId) {
        log.info("启动项目进程: {}", projectId);
        projectRunService.start(projectId);
        return Result.success();
    }

    @Operation(summary = "查询项目进程状态")
    @GetMapping("/{projectId}")
    public Result<Map<String, Object>> status(@PathVariable Long projectId) {
        return Result.success(projectRunService.status(projectId));
    }

    @Operation(summary = "停止项目进程")
    @DeleteMapping("/{projectId}")
    public Result<Void> stop(@PathVariable Long projectId) {
        projectRunService.stop(projectId);
        return Result.success();
    }
}
