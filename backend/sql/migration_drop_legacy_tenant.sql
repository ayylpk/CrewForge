-- ============================================================
-- 删除「砍掉团队/租户功能」遗留的孤儿表与列（2026-09-17）
--
-- 依据（9/17 全仓引用核对 + 现网实测）：
--   1. sys_permission          全仓零引用（无 import、无 SQL 引用）。
--      schema.sql 头部注释本来就写着"已排除：sys_project_version / sys_permission
--      （8/26 删租户遗留孤儿表，代码不再引用）"—— 但现网库里这两张表还在。
--      实测 sys_permission 有 7 行 RBAC 种子数据（perm_code/perm_name），
--      sys_project_version 0 行。
--   2. sys_project.tenant_id / project_type
--      实体 Project 的类注释写明"砍掉团队功能后：移除了 tenantId / projectType"，
--      代码既不读也不写。实测 22 行里只有 1 行是真值：
--        id=8 「hina」，tenant_id=3，project_type=2（团队项目），status=draft。
--      代码里已无任何租户过滤，这一行现在等同于普通个人项目。
--      tenant_id 上还挂着 legacy 命名的 idx_tenant 索引，随列一起消失。
--
-- 安全性：全库无外键（information_schema.key_column_usage 中 referenced_table_name 全空），
--        DROP 不会级联影响其他表。
-- 回滚：执行前已全库备份 → _archive/crewforge-before-legacy-cleanup.sql
--        （mysqldump --single-transaction --routines --events --databases crewforge）
--        要恢复：mysql -u root -p < _archive/crewforge-before-legacy-cleanup.sql
--
-- 同时已同步 schema.sql（保持"单一真相"），并删掉 sys_agent 上同样 legacy 的
-- idx_tenant 索引名（那个索引本身还有用，只是名字是租户时代的）。
-- ============================================================

-- 1. 孤儿表
DROP TABLE IF EXISTS `sys_permission`;
DROP TABLE IF EXISTS `sys_project_version`;

-- 2. sys_project 的遗留列（连同 idx_tenant 索引）
ALTER TABLE `sys_project`
  DROP COLUMN `tenant_id`,
  DROP COLUMN `project_type`;

-- 3. 顺手把 sys_agent 上 legacy 命名的索引改名（它索引的是 user_id，不是租户）
--    MySQL 8.0 支持 RENAME INDEX；老版本可 ALTER TABLE ... DROP INDEX + ADD INDEX。
ALTER TABLE `sys_agent` RENAME INDEX `idx_tenant` TO `idx_user_id`;
