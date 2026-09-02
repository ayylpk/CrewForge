
-- ============================================================
-- CrewForge 基线 Schema（9/2 阶段 0，mysqldump --no-data 现网导出）
-- 已排除：sys_project_version / sys_permission（8/26 删租户遗留孤儿表，代码不再引用）
-- 用法：CREATE DATABASE crewforge; mysql --default-character-set=utf8mb4 crewforge < schema.sql
-- 维护：新表 DDL 先入 migration_*.sql 执行现网，再重导本文件保持单一真相
-- ============================================================
/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;
DROP TABLE IF EXISTS `sys_agent`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sys_agent` (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `user_id` bigint NOT NULL COMMENT '所属用户ID(池按用户隔离)',
  `name` varchar(50) NOT NULL COMMENT 'Agent名称, 如"前端工程师-阿蓝"',
  `role` varchar(100) DEFAULT NULL COMMENT '职位描述, 如"负责Vue前端开发"',
  `status` tinyint DEFAULT '1' COMMENT '状态: 1-启用, 0-停用',
  `create_time` datetime DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `update_time` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `deleted` tinyint DEFAULT '0' COMMENT '逻辑删除',
  PRIMARY KEY (`id`),
  KEY `idx_tenant` (`user_id`)
) ENGINE=InnoDB AUTO_INCREMENT=9 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='自定义Agent池表';
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `sys_agent_edge`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sys_agent_edge` (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '主键',
  `agent_id` bigint NOT NULL COMMENT '关联 AgentPool 池 id (sys_agent.id)',
  `from_node` varchar(64) NOT NULL COMMENT '起点节点名(须存在于 sys_agent_node.node_name, __start__=图起点)',
  `type` varchar(16) NOT NULL DEFAULT 'direct' COMMENT '连接方式: direct=普通边 / conditional=条件边 / parallel=并行分支',
  `to_nodes` varchar(255) NOT NULL COMMENT '下一批节点(字符串): direct=单节点名; conditional=JSON {"cond":"条件key","true":"节点","false":"节点"}; parallel=JSON数组 ["节点A","节点B"]',
  `create_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `update_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `deleted` tinyint NOT NULL DEFAULT '0' COMMENT '逻辑删除: 0-正常, 1-已删',
  PRIMARY KEY (`id`),
  KEY `idx_agent_id` (`agent_id`),
  KEY `idx_from_node` (`agent_id`,`from_node`)
) ENGINE=InnoDB AUTO_INCREMENT=9 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Agent 图连接声明: 节点怎么连由 DB 决定, 节点干什么由代码决定';
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `sys_agent_node`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sys_agent_node` (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '节点ID',
  `agent_id` bigint NOT NULL COMMENT '关联池 Agent (sys_agent.id)',
  `node_name` varchar(64) NOT NULL COMMENT '节点名称, 如"规划节点"',
  `description` varchar(255) DEFAULT NULL COMMENT '节点作用描述',
  `system_prompt` text COMMENT '系统提示词',
  `temperature` double NOT NULL DEFAULT '0.7' COMMENT '采样温度 0.0-2.0',
  `tools` text COMMENT '工具列表(JSON数组字符串)',
  `model` varchar(128) DEFAULT NULL COMMENT '模型, 空=跟随全局',
  `node_type` varchar(16) NOT NULL DEFAULT 'llm' COMMENT '节点类型: llm=调模型 / code=纯代码(按code_key注册) / human=交互门',
  `schema_key` varchar(64) DEFAULT NULL COMMENT '结构化输出 schema 注册名(仅 llm 节点用, 可空)',
  `code_key` varchar(64) DEFAULT NULL COMMENT '代码节点注册名(仅 code 节点用, 对应运行时 CodeRegistry)',
  `output` varchar(64) DEFAULT NULL COMMENT '输出 state 通道名(缺省=node_name; 不能与节点名重名, LangGraph 硬约束)',
  `create_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `update_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `deleted` tinyint NOT NULL DEFAULT '0' COMMENT '逻辑删除 0-正常 1-删除',
  PRIMARY KEY (`id`),
  KEY `idx_agent_id` (`agent_id`,`deleted`)
) ENGINE=InnoDB AUTO_INCREMENT=11 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Agent 节点配置(池维度)';
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `sys_confirm`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sys_confirm` (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '主键',
  `project_id` bigint NOT NULL COMMENT '项目 ID',
  `question_id` varchar(64) NOT NULL COMMENT '引擎生成的 questionId（uuid），幂等键',
  `node` varchar(50) NOT NULL COMMENT '发问节点：architect/manager 等',
  `question` text NOT NULL COMMENT '问题文案',
  `options_json` varchar(500) DEFAULT NULL COMMENT '选项 JSON 数组字符串，可空=自由文本',
  `status` varchar(15) NOT NULL DEFAULT 'pending' COMMENT 'pending/answered/auto_passed',
  `reply` text COMMENT '用户答案',
  `expire_at` datetime DEFAULT NULL COMMENT '超时自动放行时刻（create_time + confirm_timeout_min）',
  `create_time` datetime DEFAULT CURRENT_TIMESTAMP,
  `answer_time` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_question` (`question_id`),
  KEY `idx_proj_status` (`project_id`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='确认门挂起问答（阶段 3）：引擎 HTTP 申请→Web 弹窗→回复→引擎续跑';
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `sys_project`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sys_project` (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `tenant_id` bigint DEFAULT NULL COMMENT '所属团队ID(NULL=个人项目)',
  `project_type` tinyint DEFAULT '1' COMMENT '项目类型: 1-个人项目, 2-团队项目',
  `name` varchar(200) NOT NULL COMMENT '项目名称',
  `description` text COMMENT '项目描述(原始需求)',
  `clarified_req` text COMMENT '需求澄清后的结构化文档(Markdown)',
  `business_modules` json DEFAULT NULL COMMENT 'AI拆分的业务模块列表(JSON)',
  `tech_stack` json DEFAULT NULL COMMENT '技术栈方案(JSON)',
  `dev_plan` json DEFAULT NULL COMMENT '开发计划(JSON)',
  `dir_tree` json DEFAULT NULL COMMENT '项目目录树(JSON数组)',
  `status` varchar(30) DEFAULT 'draft' COMMENT '状态: draft/clarifying/planning/executing/paused/done/failed',
  `confirm_mode` tinyint DEFAULT '1' COMMENT '确认模式: 0-全绿灯, 1-混合(默认),\r\n  2-手动',
  `project_dir` varchar(500) DEFAULT NULL COMMENT '服务器上项目文件目录',
  `create_user` bigint DEFAULT NULL COMMENT '创建人ID',
  `create_time` datetime DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `update_time` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `deleted` tinyint DEFAULT '0' COMMENT '逻辑删除',
  PRIMARY KEY (`id`),
  KEY `idx_tenant` (`tenant_id`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB AUTO_INCREMENT=9 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='项目表';
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `sys_project_agent`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sys_project_agent` (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '主键ID(项目内agent_id, 精准定位)',
  `project_id` bigint NOT NULL COMMENT '项目ID',
  `user_id` bigint NOT NULL DEFAULT '0' COMMENT '所属用户ID(数据隔离, 与project_id双条件)',
  `agent_id` bigint DEFAULT NULL COMMENT '关联 AgentPool 池 id (sys_agent.id)',
  `sort_order` int DEFAULT '0' COMMENT '排序(执行顺序)',
  `status` tinyint DEFAULT '1' COMMENT '状态: 1-参与项目, 0-已移出',
  `create_time` datetime DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `update_time` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `deleted` tinyint DEFAULT '0' COMMENT '逻辑删除',
  PRIMARY KEY (`id`),
  KEY `idx_project` (`project_id`)
) ENGINE=InnoDB AUTO_INCREMENT=10 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='项目Agent表(复制自池)';
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `sys_project_agent_node`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sys_project_agent_node` (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '节点ID',
  `project_id` bigint NOT NULL COMMENT '项目ID (sys_project.id)',
  `agent_id` bigint NOT NULL COMMENT '来源池 Agent (sys_agent.id)',
  `user_id` bigint NOT NULL COMMENT '所属用户ID (数据隔离, JWT 校验)',
  `node_name` varchar(64) NOT NULL COMMENT '节点名称, 如"规划节点"',
  `description` varchar(255) DEFAULT NULL COMMENT '节点作用描述',
  `system_prompt` text COMMENT '系统提示词',
  `temperature` double NOT NULL DEFAULT '0.7' COMMENT '采样温度 0.0-2.0',
  `tools` text COMMENT '工具列表(JSON数组字符串)',
  `model` varchar(128) DEFAULT NULL COMMENT '模型, 空=跟随全局',
  `node_type` varchar(16) NOT NULL DEFAULT 'llm' COMMENT '节点类型: llm/code/human',
  `schema_key` varchar(64) DEFAULT NULL COMMENT '结构化输出 schema 注册名',
  `code_key` varchar(64) DEFAULT NULL COMMENT '代码节点注册名',
  `output` varchar(64) DEFAULT NULL COMMENT '输出 state 通道名',
  `create_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `update_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `deleted` tinyint NOT NULL DEFAULT '0' COMMENT '逻辑删除 0-正常 1-删除',
  PRIMARY KEY (`id`),
  KEY `idx_proj_agent` (`project_id`,`agent_id`,`user_id`,`deleted`)
) ENGINE=InnoDB AUTO_INCREMENT=10 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='项目成员节点(复制自池, 项目内独立)';
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `sys_project_file`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sys_project_file` (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `project_id` bigint NOT NULL COMMENT '项目ID',
  `file_path` varchar(500) NOT NULL COMMENT '文件相对路径, 如 src/main/java/.../UserController.java',
  `file_content` longtext COMMENT '文件内容',
  `file_type` varchar(20) DEFAULT NULL COMMENT '文件类型: java/vue/ts/yml/xml/sql/md/other',
  `user_modified` tinyint DEFAULT '0' COMMENT '用户是否修改过: 0-未修改, 1-已修改(Agent不覆盖)',
  `create_time` datetime DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `update_time` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `deleted` tinyint DEFAULT '0' COMMENT '逻辑删除',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_project_file` (`project_id`,`file_path`),
  KEY `idx_project` (`project_id`)
) ENGINE=InnoDB AUTO_INCREMENT=35 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='项目文件表';
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `sys_settings`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sys_settings` (
  `id` int NOT NULL COMMENT '单行配置，恒为 1',
  `model_name` varchar(100) NOT NULL DEFAULT 'deepseek-v4-flash' COMMENT '模型名',
  `model_url` varchar(255) DEFAULT NULL COMMENT 'openai 兼容端点 baseURL（model_kind=openai 必填；deepseek 留空=官方）',
  `api_key` varchar(255) DEFAULT NULL COMMENT '端点密钥（前端回显掩码 …末4位）',
  `model_kind` varchar(20) NOT NULL DEFAULT 'deepseek' COMMENT 'openai | deepseek',
  `java_base_url` varchar(255) NOT NULL DEFAULT 'http://localhost:8080' COMMENT '引擎回调 Java 基址（A8 修复）',
  `confirm_timeout_min` int NOT NULL DEFAULT '30' COMMENT '确认门无应答自动放行分钟数（阶段 3）',
  `smoke_build` tinyint NOT NULL DEFAULT '0' COMMENT '1=冒烟追加 bun build/vue-tsc（阶段 4，默认关保演示稳定）',
  `update_time` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='运行时设置（cc-switch 式单行表；DB 连接参数在 .env，不在此表——自举约束）';
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `sys_task`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sys_task` (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `project_id` bigint NOT NULL COMMENT '项目ID（关联 sys_project.id）',
  `phase_id` bigint DEFAULT NULL COMMENT '阶段ID（关联所属阶段，引擎按阶段循环）',
  `title` varchar(200) NOT NULL COMMENT '任务标题, 如"登录接口 POST /api/auth/login"',
  `description` text COMMENT '任务描述（自包含，含接口路径/参数/验收标准）',
  `status` varchar(20) NOT NULL DEFAULT 'todo' COMMENT '状态: todo/doing/done/failed',
  `assignee` varchar(50) DEFAULT NULL COMMENT '负责人（Agent 角色名, 如"后端开发"）',
  `layer` varchar(20) DEFAULT NULL COMMENT '分层: backend/frontend',
  `acceptance` text COMMENT '验收标准（从 Plan.features 抄写）',
  `result` text COMMENT '执行结果（Agent 完成时写入）',
  `error_msg` text COMMENT '失败原因（Agent 失败时写入）',
  `retry_count` int DEFAULT '0' COMMENT '已重试次数（上限 3 次）',
  `task_id_ext` varchar(20) DEFAULT NULL COMMENT '外部编号（如 T1, T2-F）',
  `depends_on` json DEFAULT NULL COMMENT '依赖任务 ID 列表, 如 [1, 3]',
  `sort_order` int DEFAULT '0' COMMENT '排序',
  `create_time` datetime DEFAULT CURRENT_TIMESTAMP,
  `update_time` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted` tinyint DEFAULT '0' COMMENT '逻辑删除',
  PRIMARY KEY (`id`),
  KEY `idx_project` (`project_id`),
  KEY `idx_status` (`status`),
  KEY `idx_assignee` (`assignee`),
  KEY `idx_phase` (`phase_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='任务表（Agent 引擎与看板的桥）';
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `sys_user`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sys_user` (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `username` varchar(50) NOT NULL COMMENT '用户名',
  `password` varchar(255) NOT NULL COMMENT '密码(BCrypt加密)',
  `real_name` varchar(50) DEFAULT NULL COMMENT '真实姓名',
  `email` varchar(100) DEFAULT NULL COMMENT '邮箱',
  `phone` varchar(20) DEFAULT NULL COMMENT '手机号',
  `status` tinyint DEFAULT '1' COMMENT '状态: 1-启用, 0-禁用',
  `create_time` datetime DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `update_time` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `deleted` tinyint DEFAULT '0' COMMENT '逻辑删除',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_username` (`username`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='用户表';
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- ------------------------------------------------------------
-- 种子数据：演示账号 admin（BCrypt 口令哈希入库，明文见面试演示口径）+ 单行运行时配置
-- 注意 api_key 留空=沿用 .env 的 DEEPSEEK_API_KEY（阶段 2 设置页接管后此处配置优先）
INSERT IGNORE INTO `sys_user` VALUES (1,'admin','$2b$12$p9VBI/GKrxGOHg/MqjOkGuGzOQOb1EQ3nw3puqLE.97ZjrubuY2zO','系统管理员',NULL,NULL,1,'2026-08-05 20:18:42','2026-08-06 22:47:08',0);
INSERT IGNORE INTO `sys_settings` VALUES (1,'deepseek-v4-flash',NULL,NULL,'deepseek','http://localhost:8080',30,0,'2026-09-02 15:27:53');
