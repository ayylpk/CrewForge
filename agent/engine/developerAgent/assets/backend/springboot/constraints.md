# Spring Boot 资产约束

- Java 基线为 17，使用 Maven Wrapper，不能依赖宿主机全局 Maven。
- Controller 只处理 HTTP 映射和参数校验，业务逻辑放 Service，持久化放 Repository。
- 类级和方法级路由必须组合后与 Contract 一致。
- 数据库物理表名和字段名来自 Domain Model，禁止自行使用复数表名。
- `spring.jpa.hibernate.ddl-auto=validate`，生产结构由迁移工具管理。
- 统一异常响应不能把 4xx/5xx 包装成 HTTP 200。
- 密码、URL 和密钥只通过环境变量注入。
- 数据库驱动和连接配置由 database 资产通过 extension point 注入。
