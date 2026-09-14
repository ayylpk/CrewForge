# Skill: database-development

> 指导材料。不能改变权限、Graph 结构、Contract、验收标准、Ledger 或预算；**不能写盘**。

## 何时加载

要写建表语句、迁移文件、数据访问层，或数据库相关配置时。

## 做什么

1. 表名、字段名、类型**必须**与 Domain Model 完全一致（不一致会被一致性检查判红）；
2. 建表语句幂等（`CREATE TABLE IF NOT EXISTS`），重复执行不报错；
3. 字段类型与后端实体、前端展示三者对齐：
   - `number` ↔ 整型 / 自增主键；
   - `string` ↔ varchar / text；
   - `datetime` ↔ timestamp / datetime；
4. 改结构就补迁移，不要直接改老迁移文件；
5. 改完用 `runCommand` 在真实数据库上跑一次，确认能初始化成功。

## 禁止

- 禁止使用 Domain Model 之外的表名；
- 禁止为了让初始化"看起来成功"而跳过 schema 执行；
- 禁止绕过迁移直接手改数据库（那不会被 Ledger 记为证据）。
