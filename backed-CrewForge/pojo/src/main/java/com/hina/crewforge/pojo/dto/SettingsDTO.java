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
    /**
     * 显式清除已保存的 apiKey（9/18 加）。
     *
     *   为什么必须单独开一个开关：`apiKey` 的既有语义是"空/掩码 = 保持原值"，
     *   于是**没有办法把 key 清成空** —— 用户填错了想删掉都做不到（实测反馈）。
     *   现在：填了真值 → 覆盖；没填真值但 clearApiKey=true → 清空；两者都没有 → 保持。
     */
    private Boolean clearApiKey;
    /** deepseek | openai */
    private String modelKind;
    private String javaBaseUrl;
    private Integer confirmTimeoutMin;
    private Boolean smokeBuild;
    /** T7a 端点总闸并发上限 */
    private Integer llmConcurrency;
    /** T7a 阶段在制令牌数 */
    private Integer stationSlots;
    /** T7b 工位工具模式 */
    private Boolean toolMode;
}
