package com.hina.crewforge.controller;

import com.hina.crewforge.common.result.PageResult;
import com.hina.crewforge.common.result.Result;
import com.hina.crewforge.pojo.dto.ProjectVersionDTO;
import com.hina.crewforge.pojo.entity.ProjectVersion;
import com.hina.crewforge.pojo.vo.ProjectVersionVO;
import com.hina.crewforge.service.ProjectVersionService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@Tag(name = "ProjectVersion")
@RestController
@RequestMapping("/api/projectversion")
@RequiredArgsConstructor
@Slf4j
public class ProjectVersionController {

    private final ProjectVersionService projectversionService;

    @Operation(summary = "分页查询")
    @GetMapping
    public PageResult<List<ProjectVersionVO>> list() {

        return null;
    }

    @Operation(summary = "新增")
    @PostMapping
    public Result<Void> create(@RequestBody ProjectVersionDTO dto) {
        return Result.success();
    }

    @Operation(summary = "删除")
    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        return Result.success();
    }

    @Operation(summary = "修改")
    @PutMapping("/{id}")
    public Result<Void> update(@PathVariable Long id, @RequestBody ProjectVersionDTO dto) {
        return Result.success();
    }

    @Operation(summary = "查询单个")
    @GetMapping("/{id}")
    public Result<ProjectVersionVO> getById(@PathVariable Long id) {
        return Result.success();
    }

}
