-- 任务桥幂等键：同一项目、阶段、外部任务号只能登记一次。
-- 执行前应清理历史重复行；新部署直接使用 schema.sql。
ALTER TABLE sys_task
  ADD UNIQUE KEY uk_project_phase_task_ext (project_id, phase_id, task_id_ext);
