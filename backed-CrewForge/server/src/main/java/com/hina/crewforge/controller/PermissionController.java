package com.hina.crewforge.controller;

import com.hina.crewforge.common.result.Result;
import com.hina.crewforge.pojo.entity.PermissionRule;
import com.hina.crewforge.service.PermissionRuleService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 命令执行权限（sys_permission_rule）—— 9/18
 *
 * 三组端点，认证边界与确认门一致：
 *   Web 侧（JWT + 所有权）：规则增删查 + 最近被拒
 *   引擎侧（无 JWT，WebMvcConfig 豁免 engine/**）：判定一条命令该 allow/deny/ask
 *
 * 为什么判定要给引擎侧一个端点：跑命令的那一端（引擎 / testAgent）手里才有命令原文，
 * 而规则真相在库里。让它自己读库算=两边各有一套匹配实现，迟早漂移；
 * 让它问 Java=匹配只有一份实现（就是这个 service）。
 */
@Tag(name = "Permission（命令执行权限）")
@RestController
@RequestMapping("/api/permission")
@RequiredArgsConstructor
@Slf4j
public class PermissionController {

    private final PermissionRuleService ruleService;

    @Operation(summary = "规则列表（项目级 + 全局，含停用）")
    @GetMapping("/rules")
    public Result<List<PermissionRule>> rules(@RequestParam Long projectId) {
        return Result.success(ruleService.listVisible(projectId));
    }

    @Operation(summary = "新增/更新规则（撞唯一键即改行为）")
    @PostMapping("/rules")
    public Result<PermissionRule> addRule(@RequestBody PermissionRule rule) {
        return Result.success(ruleService.upsert(rule));
    }

    @Operation(summary = "停用规则（不物理删：复发时要靠它对照）")
    @DeleteMapping("/rules/{id}")
    public Result<Void> disableRule(@PathVariable Long id) {
        ruleService.disable(id);
        return Result.success();
    }

    @Operation(summary = "最近被拒的审批（让人看见闸门实际拦下了什么）")
    @GetMapping("/denials")
    public Result<List<Map<String, Object>>> denials(@RequestParam Long projectId,
                                                    @RequestParam(defaultValue = "20") int limit) {
        return Result.success(ruleService.recentDenials(projectId, limit));
    }

    /**
     * 引擎侧判定（无 JWT）。请求体：{projectId, tool, content}
     * 返回：{behavior, reason, ruleId, ruleContent, ruleSource}
     */
    @Operation(summary = "引擎侧判定一条命令（allow/deny/ask）")
    @PostMapping("/engine/decide")
    public Result<Map<String, Object>> decide(@RequestBody Map<String, Object> body) {
        Long projectId = body.get("projectId") == null ? null : Long.valueOf(String.valueOf(body.get("projectId")));
        String tool = body.get("tool") == null ? "bash" : String.valueOf(body.get("tool"));
        String content = body.get("content") == null ? "" : String.valueOf(body.get("content"));
        Map<String, Object> verdict = ruleService.decide(projectId, tool, content);
        log.info("[perm] 判定 project={} tool={} → {} ({})", projectId, tool, verdict.get("behavior"), content);
        return Result.success(verdict);
    }
}
