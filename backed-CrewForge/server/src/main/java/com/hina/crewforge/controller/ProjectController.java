package com.hina.crewforge.controller;

import com.hina.crewforge.common.result.PageResult;
import com.hina.crewforge.common.result.Result;
import com.hina.crewforge.pojo.QueryParam.ProjectQueryParam;
import com.hina.crewforge.pojo.dto.ProjectDTO;
import com.hina.crewforge.pojo.vo.ProjectVO;
import com.hina.crewforge.service.ProjectService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

@Tag(name = "Project")
@RestController
@RequestMapping("/api/project")
@RequiredArgsConstructor
@Slf4j
public class ProjectController {

    private final ProjectService projectService;

    @Operation(summary = "分页查询")
    @GetMapping
    public Result<PageResult<ProjectVO>> page(ProjectQueryParam projectQueryParam) {
        log.info("分页查询项目:{}", projectQueryParam);
        return Result.success(projectService.page(projectQueryParam));
    }

    @Operation(summary = "新增")
    @PostMapping
    public Result<Void> create(@RequestBody ProjectDTO dto) {
        log.info("新增项目:{}", dto);
        projectService.create(dto);
        return Result.success();
    }

    @Operation(summary = "删除")
    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        log.info("删除项目 id = {}", id);
        projectService.delete(id);
        return Result.success();
    }

    @Operation(summary = "修改")
    @PutMapping("/{id}")
    public Result<Void> update(@PathVariable Long id, @RequestBody ProjectDTO dto) {
        log.info("修改id = {}的项目为:{}", id, dto);
        projectService.update(id, dto);
        return Result.success();
    }

    @Operation(summary = "查询单个")
    @GetMapping("/{id}")
    public Result<ProjectVO> getById(@PathVariable Long id) {
        log.info("查询单个项目 id = {}", id);
        return Result.success(projectService.getById(id));
    }

    @Operation(summary = "下载项目文件 ZIP（根目录 = 项目名）")
    @GetMapping("/{id}/download")
    public ResponseEntity<byte[]> download(@PathVariable Long id) {
        log.info("下载项目文件 id = {}", id);
        byte[] zipData = projectService.downloadZip(id);
        ProjectVO project = projectService.getById(id);

        // 文件名：项目名.zip（URL 编码兼容中文）
        String filename = (project.getName() != null ? project.getName() : "project-" + id) + ".zip";
        String encodedFilename = URLEncoder.encode(filename, StandardCharsets.UTF_8).replaceAll("\\+", "%20");

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_OCTET_STREAM);
        headers.setContentDisposition(ContentDisposition.attachment().filename(filename, StandardCharsets.UTF_8).build());
        headers.setContentLength(zipData.length);

        return ResponseEntity.ok().headers(headers).body(zipData);
    }
}
