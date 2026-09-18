-- ============================================================
-- migration_rbac_admin.sql —— 权限底座：sys_user.role（2026-09-16，审计漏洞②③）
-- 现网执行：MySQL 起来后 source 本文件；执行完已把 role 列补进 schema.sql 基线（双修规矩，本 commit 已完成）
-- 不跑的代价：列不存在 → AdminGuard 按实体映射 selectById 报 SQL 错，settings 保存/测试连接不可用
-- 口径：0=管理员 / 1=普通用户；现存行默认 1，种子 admin 升 0。
--       Java 侧消费方：service/support/AdminGuard.java（每次查库、不塞 token——角色变更即时生效）
-- ============================================================
ALTER TABLE sys_user
    ADD COLUMN `role` TINYINT NOT NULL DEFAULT 1 COMMENT '角色: 0=管理员 1=普通用户';

UPDATE sys_user SET `role` = 0 WHERE username = 'admin';
