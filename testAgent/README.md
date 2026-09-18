# testAgent

> 交付前独立终检 agent：跑测试 → 看报错 → 修 → 回归，直到收敛或诚实交代剩余问题。
> 与 CrewForge 流水线无关，是项目交付前的最后一道门。

技术栈：Bun + TS + LangChain.js（ChatOpenAI 接 DeepSeek），五工具循环（bash / read / grep / edit / write）。

## 使用

```bash
bun install

# 交互模式
bun run index.ts

# 指定项目 + 自动修复（跑测试→修→循环，上限 30 迭代强制收尾）
bun run index.ts --auto --target F:\code\project\CrewForge\backed-CrewForge

# 机器可读结论（stdout 纯 JSON，过程信息走 stderr）
bun run index.ts --auto --json --target <项目>
```

`--json` 输出契约：

```json
{ "verdict": "pass | fail | incomplete | error", "testsPassed": true,
  "summary": "一句话结论", "remainingIssues": ["..."] }
```

退出码：`0` pass ／ `1` 有未解决问题（fail、incomplete）／ `2` 结论不可信（error、启动失败）。

## 环境变量（.env）

| 变量 | 说明 |
|---|---|
| `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEFAULT_MODEL` | 模型接入 |
| `BASH_TIMEOUT_MS` | bash 工具超时，默认 600000（10 分钟，够 mvn install 级命令） |
| `BASH_SHELL` | bash 工具用的 shell，Windows 默认 `bash`（Node exec 默认走 cmd 会破坏 Git Bash 承诺） |

## 项目检测

`package.json`（npm/pnpm/bun/yarn + vitest/jest/框架）→ `pom.xml`（Maven/多模块/Spring Boot）→ `build.gradle*`（Gradle）。全没检出则 `--auto` fail-fast（exit 2），不拿假命令硬跑。

## 技能机制（SKILL.md 标准）

`skills/*/SKILL.md` 启动即被 `src/skills.ts` 扫描：system prompt 只注入 name+description（L1），
正文按需 read 渐进披露（L2），references 一层直链（L3）。`--auto` 带**开工闸门**：
required 技能未读全文前 edit/write 被拦截（渐进披露不靠模型自觉，闸门是代码）。

现有技能：`testing-before-delivery`（交付前终检纪律：三类归因/红线防作弊/报告契约）。
评测：`bun run evals/run.ts`（考卷见 `evals/README.md`，RED→GREEN 闭环驱动技能演进）。
