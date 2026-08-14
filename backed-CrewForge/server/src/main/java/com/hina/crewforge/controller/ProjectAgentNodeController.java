package com.hina.crewforge.controller;

import com.hina.crewforge.common.result.Result;
import com.hina.crewforge.pojo.dto.ProjectAgentNodeDTO;
import com.hina.crewforge.pojo.vo.ProjectAgentNodeVO;
import com.hina.crewforge.service.ProjectAgentNodeService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@Tag(name = "项目成员节点")
@RestController
@RequestMapping("/api/project-agent-node")
@RequiredArgsConstructor
@Slf4j
public class ProjectAgentNodeController {

    private final ProjectAgentNodeService projectAgentNodeService;

    @Operation(summary = "按项目+池Agent查询成员节点列表")
    @GetMapping("/list")
    public Result<List<ProjectAgentNodeVO>> listByMember(@RequestParam Long projectId, @RequestParam Long agentId) {
        log.info("查询项目 {} 成员 {} 的节点列表", projectId, agentId);
        List<ProjectAgentNodeVO> list = projectAgentNodeService.listByMember(projectId, agentId);
        return Result.success(list);
    }

    @Operation(summary = "新增成员节点")
    @PostMapping
    public Result<Void> create(@RequestBody ProjectAgentNodeDTO dto) {
        log.info("新增成员节点:{}", dto);
        projectAgentNodeService.create(dto);
        return Result.success();
    }

    @Operation(summary = "修改成员节点")
    @PutMapping("/{id}")
    public Result<Void> update(@PathVariable Long id, @RequestBody ProjectAgentNodeDTO dto) {
        log.info("修改成员节点 id = {} 为:{}", id, dto);
        projectAgentNodeService.update(id, dto);
        return Result.success();
    }

    @Operation(summary = "查询单个成员节点")
    @GetMapping("/{id}")
    public Result<ProjectAgentNodeVO> getById(@PathVariable Long id) {
        ProjectAgentNodeVO vo = projectAgentNodeService.getById(id);
        return Result.success(vo);
    }

    @Operation(summary = "删除成员节点")
    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        log.info("删除成员节点 id = {}", id);
        projectAgentNodeService.deleteById(id);
        return Result.success();
    }
}
