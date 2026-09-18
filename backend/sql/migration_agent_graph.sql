-- ============================================================
-- CrewForge 图驱动 Agent 迁移脚本（MySQL 8.0）
-- 用途：把"手写图"升级为"DB 声明 → 拼接"：
--   1. sys_agent_node 补 4 列（节点类型/结构化输出/代码注册/输出通道）
--   2. 新建 sys_agent_edge（节点连线：起点 → 连接方式 → 下一批节点）
--
-- 列名说明：from/to 是 MySQL 保留字（必须反引号才可用，且 Java 驼峰
-- 映射会错位），故采用 from_node / to_nodes 承载同样语义；
-- type 非保留字，按需求原样命名。
-- ============================================================

-- ---------- 1. sys_agent_node 补列 ----------
ALTER TABLE sys_agent_node
  ADD COLUMN node_type VARCHAR(16) NOT NULL DEFAULT 'llm'
    COMMENT '节点类型: llm=调模型 / code=纯代码(按code_key注册) / human=交互门' AFTER model,
  ADD COLUMN schema_key VARCHAR(64) NULL
    COMMENT '结构化输出 schema 注册名(仅 llm 节点用, 可空)' AFTER node_type,
  ADD COLUMN code_key VARCHAR(64) NULL
    COMMENT '代码节点注册名(仅 code 节点用, 对应运行时 CodeRegistry)' AFTER schema_key,
  ADD COLUMN output VARCHAR(64) NULL
    COMMENT '输出 state 通道名(缺省=node_name; 不能与节点名重名, LangGraph 硬约束)' AFTER code_key;

-- ---------- 2. 新建 sys_agent_edge 表 ----------
CREATE TABLE IF NOT EXISTS sys_agent_edge (
  id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键',
  agent_id BIGINT NOT NULL COMMENT '关联 AgentPool 池 id (sys_agent.id)',
  from_node VARCHAR(64) NOT NULL COMMENT '起点节点名(须存在于 sys_agent_node.node_name, __start__=图起点)',
  type VARCHAR(16) NOT NULL DEFAULT 'direct' COMMENT '连接方式: direct=普通边 / conditional=条件边 / parallel=并行分支',
  to_nodes VARCHAR(255) NOT NULL COMMENT '下一批节点(字符串): direct=单节点名; conditional=JSON {"cond":"条件key","true":"节点","false":"节点"}; parallel=JSON数组 ["节点A","节点B"]',
  create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  deleted TINYINT NOT NULL DEFAULT 0 COMMENT '逻辑删除: 0-正常, 1-已删',
  INDEX idx_agent_id (agent_id),
  INDEX idx_from_node (agent_id, from_node)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4
  COMMENT = 'Agent 图连接声明: 节点怎么连由 DB 决定, 节点干什么由代码决定';

-- ---------- 3. 存量数据补默认值（可选） ----------
-- 已有节点默认都是 llm（老系统没有纯代码节点/交互门，按 llm 处理不破坏行为）
-- UPDATE sys_agent_node SET node_type = 'llm' WHERE node_type IS NULL OR node_type = '';
