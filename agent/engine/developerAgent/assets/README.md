# CrewForge 技术资产库

技术资产按 backend、frontend、database 独立注册。架构师先读取 `catalog.json` 和各资产不超过 20 行的 `summary.md`，筛选候选后才读取对应 `manifest.json`、`constraints.md` 与模板内容。

选择流程：

1. 根据需求硬约束过滤 `catalog.json`。
2. 读取候选的 `summary.md`。
3. 只对候选读取完整 manifest 和 constraints。
4. 程序校验 `requires` 是否被其他资产的 `provides` 满足。
5. 架构师输出带版本的 StackProfile，Developer 按 manifest 安装模板。

`summary.md` 只用于渐进披露，`manifest.json` 才是机器事实源。模板中的 `{{VARIABLE}}` 必须由安装器或 Developer 从结构化任务填写，不能原样交付。
