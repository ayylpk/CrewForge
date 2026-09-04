package com.hina.crewforge.controller;

import com.hina.crewforge.common.result.Result;
import com.hina.crewforge.pojo.dto.SettingsDTO;
import com.hina.crewforge.service.SettingsService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * 运行时设置接口（cc-switch 设置页）——sys_settings 单行，全局配置无需所有权（登录态即可，当前单用户）
 *
 *   GET  /api/settings          读取（apiKey 掩码回显）
 *   PUT  /api/settings          保存（掩码回传=不改 key）
 *   POST /api/settings/test     测试连接（向目标端点发 1-token 探测，不落库）
 */
@Tag(name = "Settings")
@RestController
@RequestMapping("/api/settings")
@RequiredArgsConstructor
@Slf4j
public class SettingsController {

    private final SettingsService settingsService;

    @Operation(summary = "读取运行时设置（api_key 掩码）")
    @GetMapping
    public Result<Map<String, Object>> get() {
        return Result.success(settingsService.getMasked());
    }

    @Operation(summary = "保存运行时设置（引擎 30s 内热生效）")
    @PutMapping
    public Result<Void> update(@RequestBody SettingsDTO dto) {
        log.info("保存运行时设置：kind={} model={}", dto.getModelKind(), dto.getModelName());
        settingsService.update(dto);
        return Result.success();
    }

    @Operation(summary = "测试模型端点连通性")
    @PostMapping("/test")
    public Result<Map<String, Object>> test(@RequestBody SettingsDTO dto) {
        return Result.success(settingsService.test(dto));
    }
}
