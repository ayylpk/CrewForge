-- ============================================================
-- 阶段 0 · 地基迁移（9/2，施工卡 0-1/0-2）
--   1. 修复 sys_agent_edge / sys_agent_node 的 GBK 乱码注释
--      （8/18 migration 在错误编码终端执行所致，文本以 UTF-8 源文件为准）
--   2. 新建 sys_settings（cc-switch 式运行时配置，单行；db_* 不进表——F1 修正）
--   3. 新建 sys_confirm（确认门挂起问答，阶段 3 回路）
--   注：sys_task 现网已存在（8/8 手建、0 行），基线以现网形状为准，本脚本不重建
-- 执行：mysql --default-character-set=utf8mb4 -u root -p crewforge < migration_phase0.sql
-- ============================================================

-- ---------- 1. 乱码注释修复 ----------
ALTER TABLE sys_agent_edge
  MODIFY id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键',
  MODIFY agent_id BIGINT NOT NULL COMMENT '关联 AgentPool 池 id (sys_agent.id)',
  MODIFY from_node VARCHAR(64) NOT NULL COMMENT '起点节点名(须存在于 sys_agent_node.node_name, __start__=图起点)',
  MODIFY type VARCHAR(16) NOT NULL DEFAULT 'direct' COMMENT '连接方式: direct=普通边 / conditional=条件边 / parallel=并行分支',
  MODIFY to_nodes VARCHAR(255) NOT NULL COMMENT '下一批节点(字符串): direct=单节点名; conditional=JSON {"cond":"条件key","true":"节点","false":"节点"}; parallel=JSON数组 ["节点A","节点B"]',
  MODIFY create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  MODIFY update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  MODIFY deleted TINYINT NOT NULL DEFAULT 0 COMMENT '逻辑删除: 0-正常, 1-已删';
ALTER TABLE sys_agent_edge COMMENT = 'Agent 图连接声明: 节点怎么连由 DB 决定, 节点干什么由代码决定';

ALTER TABLE sys_agent_node
  MODIFY node_type VARCHAR(16) NOT NULL DEFAULT 'llm' COMMENT '节点类型: llm=调模型 / code=纯代码(按code_key注册) / human=交互门',
  MODIFY schema_key VARCHAR(64) DEFAULT NULL COMMENT '结构化输出 schema 注册名(仅 llm 节点用, 可空)',
  MODIFY code_key VARCHAR(64) DEFAULT NULL COMMENT '代码节点注册名(仅 code 节点用, 对应运行时 CodeRegistry)',
  MODIFY output VARCHAR(64) DEFAULT NULL COMMENT '输出 state 通道名(缺省=node_name; 不能与节点名重名, LangGraph 硬约束)';

-- ---------- 2. sys_settings（F1 修正形状：只放运行时可换项）----------
CREATE TABLE IF NOT EXISTS sys_settings (
  id INT PRIMARY KEY COMMENT '单行配置，恒为 1',
  model_name VARCHAR(100) NOT NULL DEFAULT 'deepseek-v4-flash' COMMENT '模型名',
  model_url VARCHAR(255) DEFAULT NULL COMMENT 'openai 兼容端点 baseURL（model_kind=openai 必填；deepseek 留空=官方）',
  api_key VARCHAR(255) DEFAULT NULL COMMENT '端点密钥（前端回显掩码 …末4位）',
  model_kind VARCHAR(20) NOT NULL DEFAULT 'deepseek' COMMENT 'openai | deepseek',
  java_base_url VARCHAR(255) NOT NULL DEFAULT 'http://localhost:8080' COMMENT '引擎回调 Java 基址（A8 修复）',
  confirm_timeout_min INT NOT NULL DEFAULT 30 COMMENT '确认门无应答自动放行分钟数（阶段 3）',
  smoke_build TINYINT NOT NULL DEFAULT 0 COMMENT '1=冒烟追加 bun build/vue-tsc（阶段 4，默认关保演示稳定）',
  update_time DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '运行时设置（cc-switch 式单行表；DB 连接参数在 .env，不在此表——自举约束）';

INSERT INTO sys_settings (id) VALUES (1)
  ON DUPLICATE KEY UPDATE id = id;

-- ---------- 3. sys_confirm（阶段 3 确认门回路）----------
CREATE TABLE IF NOT EXISTS sys_confirm (
  id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键',
  project_id BIGINT NOT NULL COMMENT '项目 ID',
  question_id VARCHAR(64) NOT NULL COMMENT '引擎生成的 questionId（uuid），幂等键',
  node VARCHAR(50) NOT NULL COMMENT '发问节点：architect/manager 等',
  question TEXT NOT NULL COMMENT '问题文案',
  options_json VARCHAR(500) DEFAULT NULL COMMENT '选项 JSON 数组字符串，可空=自由文本',
  status VARCHAR(15) NOT NULL DEFAULT 'pending' COMMENT 'pending/answered/auto_passed',
  reply TEXT COMMENT '用户答案',
  expire_at DATETIME DEFAULT NULL COMMENT '超时自动放行时刻（create_time + confirm_timeout_min）',
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  answer_time DATETIME DEFAULT NULL,
  UNIQUE KEY uk_question (question_id),
  KEY idx_proj_status (project_id, status)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '确认门挂起问答（阶段 3）：引擎 HTTP 申请→Web 弹窗→回复→引擎续跑';
