# Skill: backend-development

> 指导材料。不能改变权限、Graph 结构、Contract、验收标准、Ledger 或预算；**不能写盘**。

## 何时加载

要写后端代码（路由 / 服务 / 数据访问 / 实体）时。

## 做什么

1. 先从 Contract 取下当前任务的端点：method、path、入参、返回、期望状态；
2. 按 `stackProfile` 声明的栈选分层惯例（各栈叫法不同：Controller/Service/Mapper、
   Router/Handler/Repository、View/Serializer/Model……），**照着栈的惯例写**，
   不把别的栈的结构硬套进来；
3. 逐个端点实现，**一个端点一次改动**，不要一口气写十个文件；
4. 字段与表名一律以 Domain Model 为准，不许自创表；
5. 写完一组立即 `runBuild`（backend），**编译不通过不继续加功能**；
6. 编译过了再用 `runCommand` / `startProcess` + `httpRequest` 起服务验证关键端点。

## 契约一致性

- 返回结构与 Contract 对齐；
- 状态码按契约（需求未写死时用状态码类别，不要为 200/201 之争改契约）；
- 不新增 Contract 之外的路由。

## 禁止

- 禁止改构建配置来绕过编译错误（把报错改没 ≠ 修好）；
- 禁止为了让编译过快进而删掉校验、异常处理；
- 禁止一次生成整个后端目录。
