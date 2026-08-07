package com.hina.crewforge.controller;

import com.hina.crewforge.common.result.PageResult;
import com.hina.crewforge.common.result.Result;
import com.hina.crewforge.pojo.dto.PermissionDTO;
import com.hina.crewforge.pojo.vo.PermissionVO;
import com.hina.crewforge.service.PermissionService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@Tag(name = "Permission")
@RestController
@RequestMapping("/api/permission")
@RequiredArgsConstructor
@Slf4j
public class PermissionController {

    private final PermissionService permissionService;

    @Operation(summary = "分页查询")
    @GetMapping
    public PageResult<List<PermissionVO>> list() {

        return null;
    }

    @Operation(summary = "新增")
    @PostMapping
    public Result<Void> create(@RequestBody PermissionDTO dto) {
        return Result.success();
    }

    @Operation(summary = "删除")
    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        return Result.success();
    }

    @Operation(summary = "修改")
    @PutMapping("/{id}")
    public Result<Void> update(@PathVariable Long id, @RequestBody PermissionDTO dto) {
        return Result.success();
    }

    @Operation(summary = "查询单个")
    @GetMapping("/{id}")
    public Result<PermissionVO> getById(@PathVariable Long id) {
        return Result.success();
    }

}
