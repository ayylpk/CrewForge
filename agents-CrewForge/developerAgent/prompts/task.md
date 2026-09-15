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

> 分批拆解说明：工作项携带 `detail` 字段时，该项一律**以 detail 为主规格**——它是架构师
> 针对这一项细化过的完整规格，比标题与路径清单更具体；detail 有冲突时以 detail 为准。

{{scaffoldHint}}

## 当前阶段 Skill

{{activeSkill}}

## 当前文件树

{{currentTree}}

## 本轮要求

1. 先读目录与相关文件，再动手；**只读调用成批发**（一轮响应里多个 readFile/search，系统并发执行只计一步）；
2. 空项目初始化先试**官方脚手架**（见上方候选节），别手写整套工程文件；
3. 用 `runCommand` / `shell` 跑真实的编译、构建、脚本与本地服务，用 `httpRequest` 打本机接口；
4. **成批写、成批验**：连续写完一个可交付批次，再用 `runAcceptance` 一次性预演
   任务包里的 COMPILE + CONTRACT 判据（自动起服务、打真 HTTP、给逐条证据）；
   **不要"改一个文件就验一次"，也不要自己写 selftest-*.mjs 临时脚本**；
5. 每条命令都要看真实 `exitCode` / `stdout` / `stderr` 再决定下一步；
6. 同一错误重复出现就停止并如实报告，不要原地重试；
7. 不要改契约、验收、测试脚本，也不要伪造结果；
8. 注意响应末尾的**预算条**：剩余不足 30% 停止新探索，不足 10% 收敛送检。
