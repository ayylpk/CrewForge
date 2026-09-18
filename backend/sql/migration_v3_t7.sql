-- ============================================================
-- migration_v3_t7.sql —— T7a 令牌闸（2026-09-08）
-- 现网执行：MySQL 起来后 source 本文件；执行完把两列补进 schema.sql 基线（"双修"规矩）
-- 不跑的代价：无——引擎读不到列走默认（llm=6 / slots=5），旁路设计
-- ============================================================

-- 最外层端点总闸：全局同时在飞 LLM 调用上限（F1 实测 8 并发尾延迟 116~443s，出厂 6）
-- 阶段令牌：每把工位阶段闸的 token 数（后端伪码/后端代码/前端设计/前端实现 各一把，共用此旋钮，出厂 5）
-- 消费方：引擎 concurrency.ts（30s 热调；Java 侧校验 llm 1~16 / slots 1~12）
ALTER TABLE sys_settings
    ADD COLUMN llm_concurrency INT NULL DEFAULT 6 COMMENT 'T7a 端点总闸：全局在飞 LLM 调用上限（默认 6）',
    ADD COLUMN station_slots  INT NULL DEFAULT 5 COMMENT 'T7a 阶段令牌：每把工位阶段闸的在制上限（默认 5）',
    ADD COLUMN tool_mode      TINYINT NULL DEFAULT 0 COMMENT 'T7b 工位工具模式：1=前后端开发走 read/write/edit 工具循环（默认 0=单发老路，端点兼容性 live 验证后再开）';
