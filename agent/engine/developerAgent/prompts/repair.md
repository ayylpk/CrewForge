# 修复注入模板（repair.md）

> TestAgent 的失败证据**原样**传进来，不允许只给自然语言摘要。
> 下面这些字段就是机器原样回传的执行事实——逐项核对，不要跳读。

## 失败证据（机器原样回传）

- category：{{category}}
- command：{{command}}
- args：{{args}}
- cwd：{{cwd}}
- exitCode：{{exitCode}}
- failureSignature：{{failureSignature}}
- affectedFiles：{{affectedFiles}}

stdout：

```
{{stdout}}
```

stderr：

```
{{stderr}}
```

## 本轮全部失败（如果有）

`allFailures` 是同一轮验收的完整红单。第一条是当前主修复项，其余条目用于避免修复一处又暴露一处；不得删除或修改其中任何证据：

```
{{allFailures}}
```

## 机械证据（机器产物，非模型生成）

`mechanicalEvidence` 是**代码亲口报的**执行事实（含每条命令的 stdout/stderr）。它不是模型编的，
也不许被改写；它同时是"修完要重跑哪几条命令"的清单：

```
{{mechanicalEvidence}}
```

## 语义审查（TestAgent 第二段 · LLM）

命令和退出码都绿了，不代表做对了。下面是语义审查的**全部**发现（不是第一条）：

- 失败来源 origin：{{failureOrigin}}
- 审查状态 reviewStatus：{{reviewStatus}}
- 审查结论：{{reviewVerdict}}（置信度 {{reviewConfidence}}）

```
{{reviewFindings}}
```

**怎么用这段**：

1. `origin = llm_review` 时，`command` 写的是 `(semantic-review)`——**它不是命令**。别去重跑它，
   也别因为"这条命令跑不起来"就上报环境问题；要修的是下面的 findings。
2. 每条 finding 都带 `evidence`（文件行号 / 机器输出 / HTTP 响应）与 `recommendation`：
   先用 `readFile` 把证据核到真实行号，再动手改。
3. **critical / major 是阻断项，必须全部修掉**——修不干净就不可能有 `test_passed`。
4. `minor` 可以判断后不修，但要在动作说明里写清"不修及原因"。
5. `reviewStatus = LLM_REVIEW_UNAVAILABLE` 不是你的错，也不是代码问题：那是审查不可用，
   任务会走人工确认。**不要**为了"让它变绿"去改验收、改脚本，或伪造任何结果。
6. 修完重新跑上面 mechanicalEvidence 里的验收命令；本地跑绿只代表"可以请测试了"。

## 要求

1. 先读 affectedFiles 的**当前**内容，并 `gitDiff` 检查刚才那次改动到底动了什么；
2. 定位**根因**，不要猜；
3. 只做**增量**修改，不重写整个项目；
4. 修改后**重新运行同一条命令**（同一 command、同一 args、同一 cwd），看它是否真的变绿；
   - 如果这条命令是构建，注意"文件没变化时不会重复执行同一条构建"——
     你要是没改到相关文件，缓存会告诉你结果没变；
5. 本地跑绿只代表"可以请测试了"，**不代表已经通过**；`verified` / `done` 只能由外部判定；
6. 编译错误 / 启动错误 / HTTP 错误的原文就是证据，不要用"应该是……"替代它；
7. 不要改 Contract、acceptance、测试脚本、Ledger，也不要通过放宽断言或改路径来规避错误；
8. 如果判断这**不是**代码问题（环境 / 依赖 / 端口 / 配置缺失），如实说明并停下；
9. 判据结果是**「不可判定」**（带 `[不可判定]` 标记）时，那是**判据侧问题**（形状非法 / 执行器
   还不支持的写法），**改代码对它无效**：不要改服务端去"凑"一条求值不了的判据，也不要反复重跑
   预演看它变不变——把 id 与原因如实上报，让上层去修判据；
10. 同一批失败判据**连续两轮失败集合没有变化**时，主动停手上报（引擎在连续 **3** 次零变化时
    会强制停手，但别等它——那说明本轮预算已经白烧了），不要继续空转；
11. 同一个 `failureSignature` 重复出现、或同一条命令连续超时两次，都应当**停止重试**并上报，
    不要无限重试同一招；
12. 证据复杂（多文件交叉 / 连续两次定位不了）时，可用
    `delegateReadonly` + `role:"debugger"` 让只读子 Agent 分析——机器证据（上面这些字段）
    由系统自动注入给它，不需要你转抄；
13. 子 Agent 的返回只是**建议**：必须 `readFile` 核实它引用的文件行号后才能动手改；
    下一轮动作说明里要写清：采纳了哪些建议、不采纳哪些**及原因**；
14. 子 Agent 不写盘、不裁判、不验收——落盘的是你，判过的是 TestAgent。
