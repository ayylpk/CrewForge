package com.hina.crewforge.controller;

import com.hina.crewforge.common.result.Result;
import com.hina.crewforge.pojo.dto.SettingsDTO;
import com.hina.crewforge.service.SettingsService;
import com.hina.crewforge.service.support.AdminGuard;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * 运行时设置接口（cc-switch 设置页）——sys_settings 单行，全局配置（9/16 审计漏洞③收口）：
 *
 *   GET  /api/settings          读取（apiKey 掩码回显）——登录态即可，前端 ProjectsView 圆点指示在用
 *   PUT  /api/settings          保存（掩码回传=不改 key）——【管理员】
 *   POST /api/settings/test     测试连接（向目标端点发 1-token 探测，不落库）——【管理员】+ 服务层防钓 key 闸
 */
@Tag(name = "Settings")
@RestController
@RequestMapping("/api/settings")
@RequiredArgsConstructor
@Slf4j
public class SettingsController {

    private final SettingsService settingsService;

    /** 管理员门卫（审计漏洞③：settings 写/测试端点需管理员；读取端保持开放——掩码无泄露面且前端 ProjectsView 在用） */
    private final AdminGuard adminGuard;

    @Operation(summary = "读取运行时设置（api_key 掩码）")
    @GetMapping
    public Result<Map<String, Object>> get() {
        return Result.success(settingsService.getMasked());
    }

    @Operation(summary = "保存运行时设置（引擎 30s 内热生效）")
    @PutMapping
    public Result<Void> update(@RequestBody SettingsDTO dto) {
        adminGuard.requireAdmin(); // 全局配置只能管理员改（审计漏洞③）
        log.info("保存运行时设置：kind={} model={}", dto.getModelKind(), dto.getModelName());
        settingsService.update(dto);
        return Result.success();
    }

    @Operation(summary = "测试模型端点连通性")
    @PostMapping("/test")
    public Result<Map<String, Object>> test(@RequestBody SettingsDTO dto) {
        adminGuard.requireAdmin(); // 真 key 会随测试请求出门，入口先验身份（审计漏洞③）
        return Result.success(settingsService.test(dto));
    }
}
