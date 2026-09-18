package com.hina.crewforge.controller;

import com.hina.crewforge.common.result.Result;
import com.hina.crewforge.service.ProjectVerifyService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 项目验收与证据（只读）——「验收与证据」页的数据源。
 *
 *   GET /api/project-verify/{projectId}
 *
 * 为什么单独一个控制器：它读的是**产物树**（{runsRoot}/p{id}/）而不是库表，
 * 与 ProjectController 的"库 CRUD"不是一类东西；混在一起会让那个类既管 DB 又管文件系统。
 *
 * JWT 由拦截器全局校验；所有权由 ProjectVerifyService → ProjectGuard 校验（防 IDOR 读产物树）。
 * 本端点**只读**：不写库、不动产物树、不触发引擎动作。
 */
@Tag(name = "项目验收与证据")
@RestController
@RequestMapping("/api/project-verify")
@RequiredArgsConstructor
@Slf4j
public class ProjectVerifyController {

    private final ProjectVerifyService projectVerifyService;

    @Operation(summary = "读项目验收证据（交付关报告 / 验收判据 / 任务证据 / 日志尾）")
    @GetMapping("/{projectId}")
    public Result<Map<String, Object>> evidence(@PathVariable Long projectId) {
        log.info("读取项目验收证据 projectId = {}", projectId);
        return Result.success(projectVerifyService.evidence(projectId));
    }
}
