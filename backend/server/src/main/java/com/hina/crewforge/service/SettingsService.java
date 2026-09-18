package com.hina.crewforge.service;

import com.hina.crewforge.pojo.dto.SettingsDTO;

import java.util.Map;

/**
 * 运行时设置服务（sys_settings 单行，cc-switch 设置页后端半边）
 */
public interface SettingsService {

    /** 当前配置（apiKey 掩码回显） */
    Map<String, Object> getMasked();

    /** 保存（校验 + 掩码值保持原 key + 单行 upsert） */
    void update(SettingsDTO dto);

    /** 测试连接：向目标端点发一条 1-token 对话，返回 {ok, latencyMs, status, error} */
    Map<String, Object> test(SettingsDTO dto);
}
