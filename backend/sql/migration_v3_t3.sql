-- ============================================================
-- migration_v3_t3.sql —— T3 模型分层双档（2026-09-08）
-- 现网执行：MySQL 起来后 source 本文件；执行完把两列补进 schema.sql 基线（"双修"规矩）
-- 不跑的代价：无——引擎读到列缺失回落内置档位表/不分层，行为等于 T3 前（旁路设计）
-- ============================================================

-- pro 档模型名（空=分层不启用，pro 角色退回全局模型名）
-- 角色档位：JSON 形状存 VARCHAR——F6 教训三连（mysql2 对 JSON 列自动 parse，按 TEXT 习惯读会拿到对象），
-- 引擎侧只做 JSON.parse(text)，坏值回落内置表；Java 侧入库前有形状校验（SettingsServiceImpl）
ALTER TABLE sys_settings
    ADD COLUMN model_pro VARCHAR(100) NULL COMMENT 'T3 pro 档模型名（空=不分层）',
    ADD COLUMN role_models VARCHAR(500) NULL COMMENT 'T3 角色→档位 JSON 文本 {"architect":"pro",...}（空=内置表）';
