package com.hina.crewforge.controller;

import com.hina.crewforge.common.result.Result;
import com.hina.crewforge.pojo.dto.ProjectFileDTO;
import com.hina.crewforge.pojo.vo.ProjectFileVO;
import com.hina.crewforge.service.ProjectFileService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@Tag(name = "ProjectFile")
@RestController
@RequestMapping("/api/projectfile")
@RequiredArgsConstructor
@Slf4j
public class ProjectFileController {

    private final ProjectFileService projectFileService;

    @Operation(summary = "项目文件列表(不分页, 一次返回项目全部文件, 不含内容)")
    @GetMapping("/list")
    public Result<List<ProjectFileVO>> list(@RequestParam Long projectId) {
        log.info("查询项目文件列表 projectId = {}", projectId);
        return Result.success(projectFileService.listByProjectId(projectId));
    }

    @Operation(summary = "新增文件(内容以 String 传入, 同一路径已存在则覆盖)")
    @PostMapping
    public Result<Void> create(@RequestBody ProjectFileDTO dto) {
        log.info("新增项目文件:{}", dto);
        projectFileService.create(dto);
        return Result.success();
    }

    @Operation(summary = "修改文件(用户编辑, 标记 user_modified=1)")
    @PutMapping("/{id}")
    public Result<Void> update(@PathVariable Long id, @RequestBody ProjectFileDTO dto) {
        log.info("修改id = {}的项目文件为:{}", id, dto);
        projectFileService.update(id, dto);
        return Result.success();
    }

    @Operation(summary = "删除")
    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        log.info("删除项目文件 id = {}", id);
        projectFileService.removeById(id);
        return Result.success();
    }

    @Operation(summary = "查询单个(含完整文件内容)")
    @GetMapping("/{id}")
    public Result<ProjectFileVO> getById(@PathVariable Long id) {
        log.info("查询单个项目文件 id = {}", id);
        return Result.success(projectFileService.getById(id));
    }
}
