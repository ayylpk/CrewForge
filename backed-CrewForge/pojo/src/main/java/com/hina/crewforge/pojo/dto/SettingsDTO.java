package com.hina.crewforge.pojo.dto;

import lombok.Data;

/**
 * 设置页入参 DTO（PUT /api/settings 与 POST /api/settings/test 共用）
 *
 * apiKey 约定：回显永远是掩码（****末4位）；提交时含 "****" 或空 = 保持库中原值不变，
 * 只有真值才覆盖——掩码往返不炸 key。
 */
@Data
public class SettingsDTO {
    private String modelName;
    /** T3 pro 档模型名 */
    private String modelPro;
    /** T3 角色档位 JSON 文本 */
    private String roleModels;
    private String modelUrl;
    private String apiKey;
    /** deepseek | openai */
    private String modelKind;
    private String javaBaseUrl;
    private Integer confirmTimeoutMin;
    private Boolean smokeBuild;
}
