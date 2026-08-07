package com.hina.crewforge.controller;

import com.hina.crewforge.common.result.PageResult;
import com.hina.crewforge.common.result.Result;
import java.util.List;
import com.hina.crewforge.pojo.QueryParam.ProjectAgentQueryParam;
import com.hina.crewforge.pojo.dto.ProjectAgentDTO;
import com.hina.crewforge.pojo.vo.ProjectAgentVO;
import com.hina.crewforge.service.ProjectAgentService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.*;

@Tag(name = "项目Agent")
@RestController
@RequestMapping("/api/project-agent")
@RequiredArgsConstructor
@Slf4j
public class ProjectAgentController {

    private final ProjectAgentService projectAgentService;

    @Operation(summary = "分页查询")
    @GetMapping
    public Result<PageResult<ProjectAgentVO>> page(ProjectAgentQueryParam projectAgentQueryParam) {
        log.info("分页查询项目agent:{}",projectAgentQueryParam);
        PageResult<ProjectAgentVO> pageResult = projectAgentService.page(projectAgentQueryParam);
        return Result.success(pageResult);
    }

    @Operation(summary = "查询全部(按项目+用户, 无分页)")
    @GetMapping("/all")
    public Result<List<ProjectAgentVO>> listAll(@RequestParam Long projectId, @RequestParam Long userId) {
        log.info("查询项目全部agent projectId = {}, userId = {}", projectId, userId);
        List<ProjectAgentVO> list = projectAgentService.listAll(projectId, userId);
        return Result.success(list);
    }

    @Operation(summary = "新增")
    @PostMapping
    public Result<Void> create(@RequestBody ProjectAgentDTO dto) {
        log.info("新增项目agent:{}",dto);
        projectAgentService.create(dto);
        return Result.success();
    }

    @Operation(summary = "删除")
    @DeleteMapping("/{ids}")
    public Result<Void> delete(@PathVariable String ids) {
        log.info("删除项目agent ids = {}", ids);
        projectAgentService.deleteByIds(ids);
        return Result.success();
    }

    @Operation(summary = "修改")
    @PutMapping("/{id}")
    public Result<Void> update(@PathVariable Long id, @RequestBody ProjectAgentDTO dto) {
        log.info("修改id = {}的项目agent为:{}", id, dto);
        projectAgentService.update(id, dto);
        return Result.success();
    }

    @Operation(summary = "查询单个")
    @GetMapping("/{id}")
    public Result<ProjectAgentVO> getById(@PathVariable Long id) {
        ProjectAgentVO vo = projectAgentService.getById(id);
        return Result.success(vo);
    }
}
