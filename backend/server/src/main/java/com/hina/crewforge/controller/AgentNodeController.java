package com.hina.crewforge.controller;

import com.hina.crewforge.common.result.Result;
import com.hina.crewforge.pojo.dto.AgentNodeDTO;
import com.hina.crewforge.pojo.vo.AgentNodeVO;
import com.hina.crewforge.service.AgentNodeService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@Tag(name = "Agent节点")
@RestController
@RequestMapping("/api/agent-node")
@RequiredArgsConstructor
@Slf4j
public class AgentNodeController {

    private final AgentNodeService agentNodeService;

    @Operation(summary = "按 agentId 查询节点列表")
    @GetMapping("/list/{agentId}")
    public Result<List<AgentNodeVO>> listByAgentId(@PathVariable Long agentId) {
        log.info("查询agentId = {}的节点列表", agentId);
        List<AgentNodeVO> list = agentNodeService.listByAgentId(agentId);
        return Result.success(list);
    }

    @Operation(summary = "新增节点")
    @PostMapping
    public Result<Void> create(@RequestBody AgentNodeDTO dto) {
        log.info("新增节点:{}", dto);
        agentNodeService.create(dto);
        return Result.success();
    }

    @Operation(summary = "修改节点")
    @PutMapping("/{id}")
    public Result<Void> update(@PathVariable Long id, @RequestBody AgentNodeDTO dto) {
        log.info("修改id = {}的节点为:{}", id, dto);
        agentNodeService.update(id, dto);
        return Result.success();
    }

    @Operation(summary = "查询单个节点")
    @GetMapping("/{id}")
    public Result<AgentNodeVO> getById(@PathVariable Long id) {
        AgentNodeVO vo = agentNodeService.getById(id);
        return Result.success(vo);
    }

    @Operation(summary = "删除节点")
    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        log.info("删除节点 id = {}", id);
        agentNodeService.deleteById(id);
        return Result.success();
    }
}
