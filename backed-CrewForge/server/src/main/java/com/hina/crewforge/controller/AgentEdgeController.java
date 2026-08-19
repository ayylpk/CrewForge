package com.hina.crewforge.controller;

import com.hina.crewforge.common.result.Result;
import com.hina.crewforge.pojo.dto.AgentEdgeDTO;
import com.hina.crewforge.pojo.vo.AgentEdgeVO;
import com.hina.crewforge.service.AgentEdgeService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@Tag(name = "Agent边")
@RestController
@RequestMapping("/api/agent-edge")
@RequiredArgsConstructor
@Slf4j
public class AgentEdgeController {

    private final AgentEdgeService agentEdgeService;

    @Operation(summary = "按 agentId 查询边列表")
    @GetMapping("/list/{agentId}")
    public Result<List<AgentEdgeVO>> listByAgentId(@PathVariable Long agentId) {
        log.info("查询agentId = {}的边列表", agentId);
        List<AgentEdgeVO> list = agentEdgeService.listByAgentId(agentId);
        return Result.success(list);
    }

    @Operation(summary = "新增边")
    @PostMapping
    public Result<Void> create(@RequestBody AgentEdgeDTO dto) {
        log.info("新增边:{}", dto);
        agentEdgeService.create(dto);
        return Result.success();
    }

    @Operation(summary = "修改边")
    @PutMapping("/{id}")
    public Result<Void> update(@PathVariable Long id, @RequestBody AgentEdgeDTO dto) {
        log.info("修改id = {}的边为:{}", id, dto);
        agentEdgeService.update(id, dto);
        return Result.success();
    }

    @Operation(summary = "查询单条边")
    @GetMapping("/{id}")
    public Result<AgentEdgeVO> getById(@PathVariable Long id) {
        AgentEdgeVO vo = agentEdgeService.getById(id);
        return Result.success(vo);
    }

    @Operation(summary = "删除边")
    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        log.info("删除边 id = {}", id);
        agentEdgeService.deleteById(id);
        return Result.success();
    }
}
