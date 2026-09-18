-- ============================================================
-- migration_phase2.sql —— 阶段 2「点火+配置层」库变更（2026-09-04）
-- 现网执行 + schema.sql 基线同步双写（承 phase0 的规矩）
--
-- 本阶段 sys_settings / sys_confirm 无需变更（阶段 0 已建齐列）；
-- 唯一新表：sys_project_run —— B4 进程落库（Java 重启不失忆 + 按阶段续拉 + 无进展熔断）。
-- ⚠️ 执行时用 UTF-8 终端（8/18 错编码终端跑 migration 把注释烤成乱码的教训）。
-- ============================================================

CREATE TABLE IF NOT EXISTS `sys_project_run` (
  `project_id` bigint NOT NULL COMMENT '项目ID（主键=外键，一项目一账）',
  `pid` bigint DEFAULT NULL COMMENT '最近一次引擎进程 PID（孤儿判活用 ProcessHandle）',
  `run_state` varchar(20) NOT NULL DEFAULT 'running' COMMENT 'running=在跑或等对账续拉 / stopped=用户停或熔断（对账器不碰）',
  `started_at` datetime DEFAULT NULL COMMENT '本轮开工时间（点开工刷新）',
  `last_spawn_at` datetime DEFAULT NULL COMMENT '最近一次拉起（无进展熔断窗起点）',
  `restart_count` int NOT NULL DEFAULT '0' COMMENT '连续无进展续拉次数（任务有更新即清零；≥5=熔断置 failed）',
  `exit_code` int DEFAULT NULL COMMENT '最近一次进程退出码（阶段边界正常收口=0）',
  `update_time` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`project_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='项目运行活账（阶段2 B4：进程落库+按阶段续拉+无进展熔断）';
