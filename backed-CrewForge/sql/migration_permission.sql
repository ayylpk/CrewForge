-- ============================================================
-- 权限与对话通道（9/18）
-- ------------------------------------------------------------
-- 做的是"本地命令执行的安全权限"：allow / deny / ask 三态 + 分层来源规则
-- + 审批卡（告诉人要执行什么）+ 三模式（全自动/混合/手动）。
--
-- 为什么扩 sys_confirm 而不另起一张表：
--   它就是 Claude Code 的 `permission.asked` —— pending → answered/auto_passed、
--   question_id 幂等、node 标明谁问、expire_at 超时、引擎侧端点已豁免 JWT、
--   前端已在轮询。再来一张表只会多一条要同步的通道。
--   这里补上"是什么卡"（kind）、"要执行什么"（detail_json）、"怎么答的"（decision）。
--
-- 为什么 rules 表要分 source：
--   同一条命令在"策略 > 项目 > 用户 > 会话"四层里可能被允许也可能被拒。
--   没有来源就无法表达"项目禁了、但你别在别的项目里也禁"。
-- ============================================================

ALTER TABLE `sys_confirm`
  ADD COLUMN `kind` varchar(20) NOT NULL DEFAULT 'question'
    COMMENT 'permission=审批卡（三态按钮）/ question=问答卡（LLM 主动提问）' AFTER `node`,
  ADD COLUMN `detail_json` text
    COMMENT '要执行什么：{command|cwd|why|preview,matchRule,tool}；审批卡与问答卡都用' AFTER `options_json`,
  ADD COLUMN `decision` varchar(20) DEFAULT NULL
    COMMENT '权限卡的裁定：allow_once / allow_always / deny（问答卡留空，看 reply）' AFTER `reply`;

-- 现有历史行都是问答卡（manager/architect 的澄清提问），默认值 'question' 已经对了。
-- 但它们的 expire_at 语义是"超时放行"，而权限卡必须 fail-closed（超时=拒绝）——
-- 这一点不改历史数据，由 ConfirmServiceImpl 按 kind 分流（见该类 targetStatusOnTimeout）。

CREATE TABLE IF NOT EXISTS `sys_permission_rule` (
  `id`           bigint       NOT NULL AUTO_INCREMENT COMMENT '主键',
  `project_id`   bigint       NOT NULL DEFAULT 0 COMMENT '0=全局（跟着人走，跨项目生效）；否则=项目级（跟着项目走）',
  `tool_name`    varchar(50)  NOT NULL COMMENT '工具名，目前只有 bash',
  `rule_content` varchar(500) NOT NULL COMMENT '规则内容，即 Bash(<这里>) ；空串=该工具的裸规则',
  `behavior`     varchar(10)  NOT NULL COMMENT 'allow / deny / ask',
  `source`       varchar(20)  NOT NULL DEFAULT 'user' COMMENT 'policy > project > user > session（判定优先级）',
  `enabled`      tinyint      NOT NULL DEFAULT 1 COMMENT '停用后仍留档，便于复发时对照',
  `note`         varchar(200) DEFAULT NULL COMMENT '人类备注：谁在什么时候点了"始终允许"',
  `create_time`  datetime     DEFAULT CURRENT_TIMESTAMP,
  `update_time`  datetime     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_rule` (`project_id`, `tool_name`, `rule_content`, `source`),
  KEY `idx_proj` (`project_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='命令执行权限规则：三态 + 分层来源，由"始终允许/拒绝"按钮写入';

-- 危险 allow 规则的剥离是**代码行为**（PermissionRuleService.isDangerousAllow），不落库：
-- 落库再依赖一张"危险清单"表，清单更新就得到处同步；而它本质是判定时的一条谓词。
