package com.hina.crewforge.controller;

import com.hina.crewforge.common.result.Result;
import com.hina.crewforge.pojo.dto.AskConfirmDTO;
import com.hina.crewforge.pojo.dto.ConfirmAnswerDTO;
import com.hina.crewforge.pojo.entity.Confirm;
import com.hina.crewforge.service.ConfirmService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 确认门接口（sys_confirm，阶段 3）——两组三态，认证边界清晰：
 *
 *   引擎侧（无 JWT，WebMvcConfig 豁免 engine/**，spawn 子进程没 token 也问得出题）：
 *     POST /api/confirm/engine/ask                 建题（questionId 幂等）
 *     GET  /api/confirm/engine/answer/{questionId} 轮询取答案（顺带 lazy 触发超时放行）
 *
 *   Web 侧（JWT + ProjectGuard 所有权）：
 *     GET  /api/confirm/pending?projectId=         待答问题列表（弹卡数据源）
 *     POST /api/confirm/{id}/answer                提交答案
 */
@Tag(name = "Confirm（确认门）")
@RestController
@RequestMapping("/api/confirm")
@RequiredArgsConstructor
@Slf4j
public class ConfirmController {

    private final ConfirmService confirmService;

    @Operation(summary = "引擎建题（幂等）")
    @PostMapping("/engine/ask")
    public Result<Map<String, Object>> ask(@RequestBody AskConfirmDTO dto) {
        return Result.success(confirmService.ask(dto));
    }

    @Operation(summary = "引擎轮询答案（pending/answered/auto_passed + reply）")
    @GetMapping("/engine/answer/{questionId}")
    public Result<Map<String, Object>> answer(@PathVariable String questionId) {
        return Result.success(confirmService.getAnswer(questionId));
    }

    @Operation(summary = "项目待答问题（Web 弹卡）")
    @GetMapping("/pending")
    public Result<List<Confirm>> pending(@RequestParam Long projectId) {
        return Result.success(confirmService.listPending(projectId));
    }

    @Operation(summary = "提交答案（一次性，重复提交报错）")
    @PostMapping("/{id}/answer")
    public Result<Void> submit(@PathVariable Long id, @RequestBody ConfirmAnswerDTO dto) {
        log.info("确认门答复 id={} → {}", id, dto.getAnswer());
        confirmService.answer(id, dto.getAnswer());
        return Result.success();
    }
}
