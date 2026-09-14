# 任务注入模板（task.md）

> 由代码把业务数据填进 `{{...}}` 占位符后，与 system.md 一起送入模型。
> 模板本身不含权限规则与流程规则——那些在 system.md 与代码里。

## 项目

- projectId：{{projectId}}
- taskId：{{taskId}}
- projectDir：{{projectDir}}
- allowedRoots：{{allowedRoots}}

## 执行环境与边界

```json
{{capabilities}}
```

## 可用工具

{{toolCatalog}}

## 架构师输入

- 需求快照 RequirementSnapshot：{{requirementSnapshot}}
- 技术栈 StackProfile：{{stackProfile}}
- Domain Model：{{domainModel}}
- Contract：{{contract}}
- 基础目录计划 FoundationPlan：{{foundationPlan}}
- 工作项清单 WorkItems：{{workItems}}
- 当前工作项 CurrentWorkItem：{{currentWorkItem}}
- 验收检查 AcceptanceChecks：{{acceptanceChecks}}
- 开发者指令 DeveloperInstructions：{{developerInstructions}}

{{scaffoldHint}}

## 当前阶段 Skill

{{activeSkill}}

## 当前文件树

{{currentTree}}

## 本轮要求

1. 先读目录与相关文件，再动手；
2. 用 `runCommand` / `shell` 跑真实的编译、构建、脚本与本地服务，用 `httpRequest` 打本机接口；
3. 每条命令都要看真实 `exitCode` / `stdout` / `stderr` 再决定下一步；
4. 改完代码必须重新运行受影响的检查；
5. 同一错误重复出现就停止并如实报告，不要原地重试；
6. 不要改契约、验收、测试脚本，也不要伪造结果。
