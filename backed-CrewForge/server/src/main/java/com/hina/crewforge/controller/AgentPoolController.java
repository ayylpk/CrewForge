package com.hina.crewforge.controller;

import com.hina.crewforge.common.result.PageResult;
import com.hina.crewforge.common.result.Result;
import com.hina.crewforge.pojo.QueryParam.AgentPoolQueryParam;
import com.hina.crewforge.pojo.dto.AgentPoolDTO;
import com.hina.crewforge.pojo.vo.AgentPoolVO;
import com.hina.crewforge.service.AgentPoolService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.*;

@Tag(name = "Agent池")
@RestController
@RequestMapping("/api/agent")
@RequiredArgsConstructor
@Slf4j
public class AgentPoolController {

    private final AgentPoolService agentService;

    @Operation(summary = "分页查询")
    @GetMapping
    public Result<PageResult<AgentPoolVO>> page(AgentPoolQueryParam agentQueryParam) {
        log.info("分页查询agent池:{}",agentQueryParam);
        PageResult<AgentPoolVO> pageResult = agentService.page(agentQueryParam);
        return Result.success(pageResult);
    }

    @Operation(summary = "新增")
    @PostMapping
    public Result<Void> create(@RequestBody AgentPoolDTO dto) {
        log.info("新增agent:{}",dto);
        agentService.create(dto);
        return Result.success();
    }

    @Operation(summary = "删除")
    @DeleteMapping("/{ids}")
    public Result<Void> delete(@PathVariable String ids) {
        log.info("删除agent ids = {}", ids);
        agentService.deleteByIds(ids);
        return Result.success();
    }

    @Operation(summary = "修改")
    @PutMapping("/{id}")
    public Result<Void> update(@PathVariable Long id, @RequestBody AgentPoolDTO dto) {
        log.info("修改id = {}的agent为:{}", id, dto);
        agentService.update(id, dto);
        return Result.success();
    }

    @Operation(summary = "查询单个")
    @GetMapping("/{id}")
    public Result<AgentPoolVO> getById(@PathVariable Long id) {
        AgentPoolVO vo = agentService.getById(id);
        return Result.success(vo);
    }
}
