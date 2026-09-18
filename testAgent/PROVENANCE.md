# testAgent 来源说明（PROVENANCE）

## 从哪来

2026-09-18 从**仓外**搬入本仓：

```
F:\code\agent\testAgent   →   CrewForge/testAgent/
```

搬之前它是**一个独立的 git 仓库**，CrewForge 只通过环境变量/绝对路径指向它：

```ts
// agents-CrewForge/testAgentAdapter.ts（旧）
const testAgentDir = opts.testAgentDir ?? process.env.TESTAGENT_DIR ?? "F:/code/agent/testAgent";
```

也就是说：clone 本仓**拿不到裁判**，得靠那台机器上恰好有 `F:/code/agent/testAgent`。
搬进来之后默认值改成仓内相对路径，clone 即自带。

## ⚠️ 两件必须知道的事

### 1. 原来的 git 历史**没有**搬过来

`.git/`（0.1 MB）留在原地没动，本目录是**纯源码快照**。
原仓最后一次提交是 `58cf935`（"外部评审七条修订：排除条件进 L1 + 弱档跨模型验证"）。

### 2. 这份快照 = 原仓的**工作区**，比它的 HEAD 更新

搬的时候原仓有**未提交的改动**：

```
 M index.ts
 M src/context.ts
 M src/main.ts
?? src/review.ts        ← 41 KB，整个文件从未提交
?? src/verify.ts        ← 18 KB，整个文件从未提交
?? tests/               ← 三个测试文件共 56 KB，从未提交
```

所以**不能**拿原仓的 `git log`/`git show` 当"权威版本"对照——那些文件在它那边压根没进过 git。
如果将来要回溯，看的是**本仓的提交历史**（从搬入那一笔起）。

## 没搬的东西（都可再生，不是丢失）

| 没搬 | 为什么 | 怎么恢复 |
|---|---|---|
| `.git/` | 保持本仓是**单一仓库**，避免嵌套 repo | 原目录还在 `F:\code\agent\testAgent`，未删 |
| `node_modules/` | 152 MB，`bun install` 9 秒可重现 | `cd testAgent && bun install`（已实测：143 包 / 9.28s） |
| `evals/results/` | 生成物（它自己的 .gitignore 里就写着"每次重跑覆盖，不入库"） | `bun run evals/run.ts` |

## 搬完验过什么

| 验证 | 结果 |
|---|---|
| CrewForge 侧适配器真 spawn 新位置的 testAgent | `bun test tests/testAgentAdapter.test.ts` → **12 过 0 败**（34.6s） |
| testAgent 自己的测试套 | `cd testAgent && bun test tests/` → **60 过 0 败** |
| 依赖能装 | `bun install` → 143 包 / 9.28s / 152.1 MB |

> 注意：在 `testAgent/` 根目录直接 `bun test`（不带 `tests/`）会**连夹具一起跑**，
> 于是必然看到 3 个红：`f1-js-failing` 的两个断言（夹具名字就叫 failing）、
> `f4-broken` 的 `PROD_DEPLOY_KEY` 门禁（故意缺 key 的 RED 基线）。
> **那 3 个红是设计如此，不是回归**——跑自己的套请用 `bun test tests/`。

## 与引擎的契约是"手工镜像"

`testAgent/src/verify.ts` 的结构 ↔ `agents-CrewForge/testAgentAdapter.ts` 里的类型
（`AdapterVerifyRequest` / `AdapterVerifyResult` / `IDENTITY_FIELDS` …）是**逐字段手抄**的，
适配器第 37 行的注释写着"跨仓不 import，字段逐一对应"。

搬进同一个仓库后**仍然没有共享类型**（两个 tsconfig、两套 node_modules）。
真要收掉这个脆点，得让适配器直接 import `testAgent/src/verify.ts` 的类型——
那是一次独立改动，不要顺手做。
