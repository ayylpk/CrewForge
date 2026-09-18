# 测试日志阅读卡（各栈报错定位速查）

目录：[bun test](#bun-test) · [vitest/jest](#vitestjest) · [maven](#maven) · [gradle](#gradle) · [超长日志通用策略](#超长日志通用策略)

## bun test

- 看末尾统计行：`N pass  M fail`。
- 失败块以 `✗ 测试名` 开头，紧跟 `error: expect(received).toBe(expected)` 差异对，
  `at <file>:<line>:<col>` 直接指向断言位置——断言行≠bug 行，按差异对回实现代码找根因。

## vitest/jest

- 末尾 `Tests  N failed | M passed`。
- 失败块 `FAIL <file> > <suite> > <test>`，diff 高亮 received/expected。
- 快照失败（snapshot）多为有意变更：不许直接 `-u` 更新快照了事，列入 remainingIssues 交人确认。

## maven

- **报错几乎全在 stdout**（本项目 bash 工具会把 stdout/stderr 都带回）。
- 定位顺序：搜 `BUILD FAILURE` → 其上找 `Tests run: N, Failures: F, Errors: E` →
  再看 `<<< FAILURE!` / `<<< ERROR!` 标记的用例块。
- 编译错 `[ERROR] COMPILATION ERROR` 在测试前，先修编译再看测试。
- 详细报告：`target/surefire-reports/*.txt`（控制台被截断时读这里）。
- 多模块：根目录跑全量；单模块 `-pl <模块> -am`。

## gradle

- 失败行以 `> Task :xxx:test FAILED` 标记；
- 用例明细在 `build/test-results/test/*.xml` 与 `build/reports/tests/test/index.html`。

## 超长日志通用策略

1. 输出被 `[OUTPUT_OVERFLOW]` 或截断标记掐掉时：`<命令> > out.log 2>&1` 落盘。
2. `grep -n "FAIL\|Error\|✗" out.log` 先拿行号，再 `read` 带 offset 精读错误块前后 50 行。
3. `[TIMEOUT]` ≠ 失败：确认命令是否在等交互输入、是否该只跑子集。
