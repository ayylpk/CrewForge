# `contextBudget.ts` —— Claude Code 压缩机制的移植说明与接线契约

> 本文件回答三件事：
> ① **机制对照**：五个必合项，源码在哪、本模块在哪（§0）；
> ② **移植了什么、哪些地方被改了、哪些地方抄不到**（§1–§4）；
> ③ **怎么接进 `graph.ts`**（§5）。
> 算法口径看 `contextBudget.ts` 的文件头与 `tests/context-budget.test.ts`（112 条用例，
> 其中 `★ 机制必合项` 那一组就是验收口径）。

源码根：`F:\code\GitHub\claude-code-source\claude-code-source\src`。
本移植只读 `.ts` 源码，未碰 `node_modules` / `dist` / 压缩产物。checkout 是**真源码**，可读。

---

## 0. 机制对照（**这是验收口径**）

目标不是逐行照抄，是**机制一致**。五项逐条对账：

| # | 机制必合项 | 源码怎么做的（file:line） | 本模块在哪 | 换一套机制就会挂的断言 |
|---|---|---|---|---|
| ① | **什么时候压** | 量的是 `tokenCountWithEstimation`：`tokenCountWithEstimation:226-261` 取**最后一次 API 响应**的 `input + cache_creation + cache_read + output`，再加其后新增消息的粗糙估算；`autoCompact.ts:119-120, 233-238` 拿它与 `threshold` 比，`>=` 即触发 | §3 + §12 | `机制必合项 › ①`（四项全算 + 换窗口翻转判定） |
| ② | **压什么** | 微压缩只碰 `COMPACTABLE_TOOLS` 白名单工具的 `tool_result`，除最近 `keepRecent` 条外清成占位符（`microCompact.ts:41-50, 456-492`）；宏压缩把边界之后的整段对话交给摘要调用，且请求里 `tools` 收到只剩读文件、`thinking` 关掉、系统提示词固定（`compact.ts:1292-1326`） | §5 + §9 | `机制必合项 › ②`（白名单内清 / 白名单外不碰 / 最近的保留 / 请求形状） |
| ③ | **保留什么、丢什么、什么顺序** | 产物顺序 `boundary → summary → messagesToKeep → attachments → hookResults`（`compact.ts:330-338`）；"丢"的只有被摘要覆盖的那一段；保留段按 `minTokens / minTextBlockMessages / maxTokens` 三闸切片（`sessionMemoryCompact.ts:324-397`），且不许劈开 tool_use/tool_result 配对或同 id 的 thinking 块（`:232-314`） | §9 + §10 | `机制必合项 › ③`（顺序数组 + 三闸 + 配对不劈开） |
| ④ | **边界怎么表示** | 一条 `system` 消息，`subtype:'compact_boundary'`，`content:'Conversation compacted'`，带 `compactMetadata{trigger,preTokens,messagesSummarized}`（`messages.ts:4530-4555`）；**切分语义**＝"最后一道边界之后才是活的对话"（`getMessagesAfterCompactBoundary` `:4643-4657`），边界本身进 API 时被滤掉（`:4641` 注释） | §7 | `机制必合项 › ④`（形状 + 最后一道边界切片 + system 被滤） |
| ⑤ | **摘要怎么回灌** | 一条 `user` 消息，`isCompactSummary:true` + `isVisibleInTranscriptOnly:true`（`compact.ts:613-624`），正文＝`getCompactUserSummaryMessage`：抬头 *"This session is being continued from a previous conversation that ran out of context."* ＋`formatCompactSummary` 处理过的摘要（剥 `<analysis>`、`<summary>`→`Summary:`，`prompt.ts:311-335`），自动压缩再追加 *"Continue the conversation from where it left off …"*（`:357-370`）；位置在**保留段之前** | §8 + §9 | `机制必合项 › ⑤`（抬头/尾句/形状/草稿不进上下文/位置在保留段前） |

**阈值怎么来的**（可以变，但要按源码的方式推导）：源码的公式是
`eff − 13_000`，其中 `eff = 窗口 − min(最大输出, 20_000)`（`autoCompact.ts:30, 33-49, 62-91`）
——**对窗口的扣减**，四个扣减量（13_000 / 20_000 / 20_000 / 3_000）在源码里都是绝对值，
隐含"窗口 200_000"这个前提（200_000 − 20_000 = 180_000）。

本产品的窗口是**用户填的**（可能是 32K，也可能是 1M），绝对值扣减在小窗口上会退化成负数
（32_000 − 20_000 − 13_000 = **−1_000** → 每轮都判"该压"）。所以本模块把四个绝对值
**按源码自己的标定窗口折算成比例**（分母就是那个 180_000），公式形状一字不改：

```
eff = 窗口 − min(模型最大输出, 20_000)
线  = eff − floor(eff × 13_000/180_000)      ← 预警/阻塞同理，分母都是 180_000
```
在 200_000 窗口上这三条**逐位等于 cc**（167_000 / 147_000 / 177_000，有对拍测试
`getCcExactThresholds`）。**这不是我发明的比例**：源码里本来就有走百分比的那条路
（`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`，`autoCompact.ts:79-88`），本模块只是把它提升为默认。

### 0.1 窗口从哪来（**产品接线面**）

| 优先级 | 来源 | 字段 / 入口 | `source` |
|---|---|---|---|
| ① | pro 档专用覆盖 | `sys_settings.context_window_pro` | `settings-tier` |
| ② | 用户填的全局基准 | `sys_settings.context_window` | `settings` |
| ③ | 模型名自带 `[1m]` | `model_pro` / `model_name` 文本里的后缀 → 1_000_000 | `model-suffix` |
| ④ | 运维逃生口 | env `CF_CONTEXT_WINDOW_TOKENS` | `env` |
| ⑤ | **产品默认**（用户没配时） | 常量 `DEFAULT_CONTEXT_WINDOW_TOKENS = 256_000` + **一行告警** + `degraded: true` | `unset-default` |

③ 在 ④ 前面是有意的：模型名也是 `sys_settings` 里的值，用户写了 `[1m]` 就是声明了 1M；
运维要**封顶**请用 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`（取 min 的闸，任何情况下都生效）。
若让 ④ 压过 ③，同一个 `deepseek-v4-pro[1m]` 会算出两个不同的窗口（一个入口认名字、一个认 env），
那是自相矛盾。

**未配置时的默认 = 256_000（256K，产品拍板）。** 它与用户填的值走**完全同一套**百分比阈值，
只是来处不同（`source: "unset-default"` 而不是 `"settings"`）——测试里有一条专门钉住
"默认路径与显式配成 256000 逐位同解"。256K 上：`eff = 236_000`，线 `218_956`，
预警 `192_734`，阻塞 `232_067`。

> ⚠️ **方向要记清楚**：256K **大于** cc 自己标定的 200K。而"窗口 − min(最大输出,20_000)"
> 之后再按比例上收，意味着**假设偏大 ⇒ 线偏高 ⇒ 压缩触发偏晚**。若本机模型真实窗口比 256K 小，
> 就会在该压的时候没压，一路发到越窗（400 / 决策丢失 → 白烧一轮，历史实测 45s/次）。
> 所以默认值这一档**必须可见**：`degraded = true` + 一行告警 + 台账留痕。
> 真正安全的做法只有一个——**在设置页填真实值**；临时收紧可以用
> `CLAUDE_CODE_AUTO_COMPACT_WINDOW`（取 min，不改库）。
> 为什么仍要有默认值而不是"没配就不压"：没配就不压等于把越窗保护整个关掉。给默认值 + 让它可见，是更小的一步。

> 📌 pro 档的 `[1m]` 模型名就是"单一写死的窗口是错的"最好的例子：同一个部署里 flash 档
> 可能只有 128K，pro 档是 1M，差 8 倍。分档解析（①③）与 per-tier 覆盖就是为这件事存在的。

> 🔗 **字段别名（与接线层的契约）**：`ContextWindowSpec` 同时提供
> `contextWindowTokens`（规范名，owner 规格里的写法）与 `contextTokens`（同值别名）。
> 起因是 `developerAgent/contextCompaction.ts`（接线层，另一位作者）按 `window.contextTokens` 取值；
> 与其让两边字段名打架，不如由本模块同时给两个名字。**两者永远同值**；
> 手工构造 spec 只填任意一个也会被 `asWindowSpec` 补齐（不会静默变 0）。
> 测试 `★ 字段别名是契约` 钉着这条 —— 别顺手删别名，那会直接打断接线。
> 入参侧同理：`contextTokens` / `contextTokensPro` 是 `contextWindowTokens` /
> `contextWindowProTokens` 的同义写法。

---

## 1. 源码章节 ↔ 本文档章节

| 源码文件 | 本模块章节 | 移植方式 |
|---|---|---|
| `services/tokenEstimation.ts` | §1 | 逐函数 |
| `utils/context.ts` + `services/api/claude.ts`（窗口/输出上限） | §2 | 逐函数（去掉 ant-only 分支） |
| `utils/tokens.ts` | §3 | 逐函数 |
| `services/compact/timeBasedMCConfig.ts` | §4 | 逐字段（配置来源换掉，见 §3 适配） |
| `services/compact/microCompact.ts` | §5 | 逐函数（cached MC 见 §4 缺口） |
| `services/compact/grouping.ts` | §6 | 逐行 |
| `utils/messages.ts`（压缩相关） | §7 | 逐函数 |
| `services/compact/prompt.ts` | §8 | **逐字**（提示词原文照抄） |
| `services/compact/compact.ts` | §9 | 逐段（副作用换成端口） |
| `services/compact/sessionMemoryCompact.ts` + `SessionMemory/prompts.ts` | §10 | 逐函数（记忆来源改成注入） |
| `services/compact/apiMicrocompact.ts` | §11 | 逐行 |
| `services/compact/autoCompact.ts` | §12 | 逐行（阈值全保留） |
| `services/compact/postCompactCleanup.ts` | §13 | 保留语义，落地项按本仓库能力裁剪 |
| —（本仓库新增） | §0 / §14 | **唯一的非移植部分**，只有适配与台账壳 |

---

## 2. 机制本身（源码怎么做的，带 file:line）

### 2.1 触发阈值是**从模型窗口推出来的**，不是常数

```
getEffectiveContextWindowSize(model)
  = getContextWindowForModel(model) − min(getMaxOutputTokensForModel(model), 20_000)
                                                              ↑ MAX_OUTPUT_TOKENS_FOR_SUMMARY
getAutoCompactThreshold(model) = getEffectiveContextWindowSize(model) − 13_000
```
`autoCompact.ts:30, 33-49, 62-91`。200K 窗口 → `200000 − 20000 − 13000 = **167_000**`。
另有 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`（取 min）、`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`（取 min）。

四档与阻塞线（`autoCompact.ts:62-65, 93-145`）：
`warning = error = threshold − 20_000`、`blockingLimit = effectiveWindow − 3_000`。
**注意**：warning 与 error 两个缓冲都是 20_000，所以 `isAboveErrorThreshold` 蕴含
`isAboveWarningThreshold`，"只在 warning 档"这个状态在默认配置下不可达（测试里钉住了这一条）。

### 2.2 触发之后先试 session memory，再走传统摘要

`autoCompactIfNeeded`（`autoCompact.ts:241-351`）顺序：
`DISABLE_COMPACT` 短路 → **熔断器**（连续失败 ≥3 次直接放弃，源码注释记了 1275+ 个会话连续失败 50+ 次）
→ `shouldAutoCompact` → `trySessionMemoryCompaction` → 失败才 `compactConversation` →
catch 里累加 `consecutiveFailures`。

### 2.3 压缩 = 一次独立的摘要调用，产出**整份新消息数组**

- 提示词：`getCompactPrompt()` = `NO_TOOLS_PREAMBLE` + `BASE_COMPACT_PROMPT` +
  `[Additional Instructions]` + `NO_TOOLS_TRAILER`（`prompt.ts:19-303`）。
- 请求：system = `"You are a helpful AI assistant tasked with summarizing conversations."`，
  `thinkingConfig: {type:'disabled'}`，tools 只剩 `[FileReadTool]`，
  `maxOutputTokensOverride = min(20_000, getMaxOutputTokensForModel(model))`，
  `querySource: 'compact'`（`compact.ts:1292-1326`）。
- 摘要回来之后：`formatCompactSummary` 剥掉 `<analysis>`、把 `<summary>` 换成 `Summary:` 抬头
  （`prompt.ts:311-335`）。
- **回灌方式**：一条 `user` 消息，`isCompactSummary: true` + `isVisibleInTranscriptOnly: true`，
  正文 = `getCompactUserSummaryMessage(...)`（`prompt.ts:337-373`）：
  `"This session is being continued from a previous conversation that ran out of context."` +
  摘要 + 可选 transcript 路径 + 可选 `"Recent messages are preserved verbatim."` +
  自动压缩时追加 `"Continue the conversation from where it left off …"`。
- **组装**：`buildPostCompactMessages` = `[边界标记, ...摘要消息, ...messagesToKeep, ...附件, ...hookResults]`
  （`compact.ts:330-338`），然后**整份赋值**给查询用的消息数组（`query.ts:535` / `:1153`），
  从不 splice 中部。
- 副作用：**清空 `readFileState`**（`compact.ts:517-521`）——压缩后必须重新 Read 才能 Edit；
  压缩后回灌最近读过的 ≤5 个文件（`compact.ts:1415-1464`，同时受 50_000 token 预算约束）。

### 2.4 保留 / 摘要 / 丢弃

- **丢弃**：被摘要覆盖的那一段（`buildPostCompactMessages` 里只剩边界 + 摘要）。
  全量压缩没有 `messagesToKeep`。
- **保留（逐字）**：`sessionMemoryCompact` 的尾部切片（`minTokens 10_000` /
  `minTextBlockMessages 5` / `maxTokens 40_000`，`sessionMemoryCompact.ts:57-61, 324-397`），
  并且**不许把 tool_use / tool_result 配对或同一 message.id 的 thinking 块劈开**
  （`adjustIndexToPreserveAPIInvariants`，:232-314）。
- **摘要里必须出现的九节**：user 的显式请求 / 技术概念 / 文件与代码段 / 错误与修复 /
  问题解决 / **全部 user 消息** / 待办 / 当前工作 / 下一步（`prompt.ts:66-77`）。
- **最后一招**：摘要调用自己撞 prompt-too-long 时，按 API round 丢最老的组重试，最多 3 次
  （`truncateHeadForPTLTry` + `MAX_PTL_RETRIES`，`compact.ts:227-291, 450-491`）。

### 2.5 微压缩（**默认是关的**，这一点很关键）

`microcompactMessages`（`microCompact.ts:253-293`）三条路径：
1. **时间触发**（先跑并短路）：距最后一条 assistant 消息超过 `gapThresholdMinutes`（默认 **60**，
   因为服务端 1h 缓存 TTL 必然过期）时，把除最近 `keepRecent`（默认 **5**，下限 **1**）条以外的
   可压缩工具结果正文换成 `'[Old tool result content cleared]'`。
   配置默认 **`enabled: false`**（`timeBasedMCConfig.ts:30-34`）。
2. **cached MC**（服务端 `cache_edits`，需要 ant-only 模块与支持 cache editing 的模型）——
   它**不改本地消息**，只在 API 层排队删除。
3. **兜底：什么也不做。** 源码原话（`microCompact.ts:288-292`）：
   *"Legacy microcompact path removed … For contexts where cached microcompact is not available
   (external builds, non-ant users, unsupported models, sub-agents), no compaction happens here;
   autocompact handles context pressure instead."*

可压缩工具白名单（`microCompact.ts:41-50`）：Read / Bash / PowerShell / Grep / Glob /
WebSearch / WebFetch / Edit / Write。
token 估算在微压缩与 session memory 里都要 **×4/3 保守加价**（`microCompact.ts:203-204`）。

### 2.6 token 口径

`tokenCountWithEstimation`（`utils/tokens.ts:226-261`）是源码点名的 **CANONICAL** 口径：
最后一条 API 响应的 `input + cache_creation + cache_read + output`
＋ 其后新增消息的粗糙估算（`roughTokenCountEstimation = round(len/4)`，JSON 类文件用 `/2`）。
它明确要求**不要**用累计计数、不要用 `output_tokens`、不要用不含估算的版本。

---

## 3. 适配清单（**每一处偏离源码的地方**，及原因）

> 判据：**机制**必须一致（§0 的五项）；下面这些是宿主适配，可以选、但必须写明。

| # | 位置 | 源码 | 本移植 | 为什么 |
|---|---|---|---|---|
| A0 | §2 | `getModelCapability()` 的服务端能力表决定窗口 | `contextWindowSource(model)`：`CF_CONTEXT_WINDOW_TOKENS` → `[1m]` 后缀 → cc 的 200_000 常数，并返回 `source`（事实/假设可分辨） | 阈值公式必须保留，但公式的**输入**是部署事实。cc 从自家能力表拿，本仓库没有那张表，就用一个显式、可审计、可配置的入口 |
| A1 | §0 | `Message[]`：`{type:'user'\|'assistant'\|'system'\|'attachment'}`，assistant 的 tool_use 与 user 的 tool_result 靠 id 配对 | 同名同形类型 + `historyToMessages` / `messagesToHistory` 双向适配 | CrewForge 的 `runToolLoop` 是**扁平** `history`（`{tool,args,ok,output}` 等），没有 role/id/配对。压缩算法（配对不劈开、按 id 收集可压缩结果）必须有配对形状才成立，所以先适配再压缩 |
| A2 | §0 | `randomUUID()` / `new Date().toISOString()` | 同样是默认，但允许注入 `ids` | 测试要能重放（"同输入 → 同输出"）。生产不传就是源码行为 |
| A3 | §2 | `getModelCapability()` 服务端能力表、`resolveAntModel`、`getCanonicalName` | 去掉；保留 1M beta 与 `MODEL_CONTEXT_WINDOW_DEFAULT` 分支 | 本仓库没有那张表。外部构建本来也走不到那些分支 |
| A4 | §2 | `getFeatureValue('tengu_otk_slot_v1', false)` | 直接返回 false | 3P 默认就是 false（`claude.ts:3394-3397`），取值一致 |
| A5 | §4/§10 | GrowthBook（`tengu_slate_heron` / `tengu_sm_compact_config` / `tengu_session_memory` / `tengu_sm_compact`） | 进程内可变配置 + `setXxx()` + 环境变量 JSON 覆盖；**默认值与源码逐字相同** | 本仓库没有 GrowthBook。默认值不动 = 行为不动 |
| A6 | §4 | `feature('CACHED_MICROCOMPACT')` 等 bun:bundle 编译期开关 | `FEATURE_FLAGS_EXTERNAL` 常量表，全部取**外部构建**值（false） | 没有 bun:bundle 的 feature 系统。取外部值是为了与"cc 发给外部用户的行为"一致 |
| A7 | §5 | cached MC 从 GrowthBook 拿 `triggerThreshold` / `keepRecent` | 改成**必须注入**（`setCachedMicrocompactConfig`），未注入 → 该路径不生效 | **那两个数字读不出来**（见 §4 缺口），不编造 |
| A8 | §8/§9 | `queryModelWithStreaming` / `runForkedAgent`（含 prompt cache 共享、keep-alive、流式重试） | `CompactHost.summarize(request)` 端口；请求体构造（`buildSummaryRequest`）仍逐字移植 | 传输层与 UI 无关；本仓库的模型客户端是 `realLlm.ts` |
| A9 | §9 | `normalizeMessagesForAPI`（1000+ 行：合并同 message.id、补 tool 配对、attachment 展开…） | **只移植压缩依赖的最小语义**：滤掉 `system` 与 `attachment` | 这是本移植**最大的一处近似**。本仓库的适配层每条 assistant 只有一个块，不需要合并；配对由适配层保证 |
| A10 | §9 | `getPromptTooLongTokenGap(errorDetails)` 解析服务端 413 报文 | 保留形参 `tokenGap`，由调用方给；不给就走 20% 兜底 | 本仓库的 client 不保留 errorDetails。兜底分支与源码注释一致（"Falls back to dropping 20% of groups when the gap is unparseable"） |
| A11 | §9 | `executePreCompactHooks` / `processSessionStartHooks` / `executePostCompactHooks` | `CompactHost.preCompactHooks` / `sessionStartHooks` 端口，不注入 = 空 | 本仓库没有 hooks 体系 |
| A12 | §9 | `generateFileAttachment`（FileReadTool + 文件类型识别 + 分块 + 计划/技能/子 agent 附件 + 延迟工具表） | 只保留**文件回灌**（`readFile` 端口 + 同名常量 + 同样的窗口/预算），其余附件类型不适用 | 计划文件、技能列表、延迟工具表都是 cc 的概念 |
| A13 | §9 | `context.readFileState.clear()` | 清**注入进来的** `host.readFileState` 对象 | 状态由 LangGraph/台账持有 |
| A14 | §10 | `getSessionMemoryContent()` / `getLastSummarizedMessageId()` / `waitForSessionMemoryExtraction()` | 前两样改成**参数注入**；第三样（等后台提取）去掉 | 本仓库没有 SessionMemory 子系统。切片算法（`calculateMessagesToKeepIndex`）原样移植 |
| A15 | §11 | 把 `context_management.edits` 塞进请求体 | 只移植**构造逻辑**，是否发送由调用方决定（默认不发） | 端点（DeepSeek 的 Anthropic 兼容层）未必支持该字段 |
| A16 | §12 | `getGlobalConfig().autoCompactEnabled` | `setAutoCompactEnabled()`，默认 true | 没有全局 config |
| A17 | §13 | 清 6 处进程内缓存 | 只清本仓库存在的（microcompact 模块状态 + readFileState）；其余在注释里列明"没有对应物" | 避免写一堆空壳函数让后来人以为漏了 |
| A18 | §14 | `messagesForQuery = buildPostCompactMessages(result)` + REPL 侧状态 | `applyCompactionToHistory()` 做同一件事，并把结果映射回扁平 history | 接线壳 |
| A19 | §8 | `Message.isVisibleInTranscriptOnly` | 保留 | 源码里它只影响 **UI 渲染**（`MessageSelector.tsx:780`、`VirtualMessageList.tsx:148`），不影响发给模型；`QueryEngine.ts:579` 用它打 `isSynthetic` |
| A20 | §8 | `PROACTIVE` / `KAIROS` 的 `proactiveModule.isProactiveActive()` 分支 | 去掉（feature 恒 false） | 不可达分支 |
| A21 | §5/§8 | `HISTORY_SNIP` 的过滤 | 去掉（feature 恒 false） | 同 A6 |
| A22 | §8 | 摘要提示词的**措辞**（说明里"可以改"的那一类） | **照抄了 cc 的原文**（`NO_TOOLS_PREAMBLE` / `BASE_COMPACT_PROMPT` / `NO_TOOLS_TRAILER` 等） | "措辞可以不同"是**许可**不是要求。照抄信息量最大（人家调过），也省得以后对不上；要改就改 §8，机制不受影响 |
| **A23** | §12 | 四个扣减量是**绝对值**（13_000 / 20_000 / 20_000 / 3_000），且隐含"窗口 200_000" | 按源码自己的标定 eff（180_000）**折算成比例**；在 200_000 上逐位等于 cc | 本产品的窗口是**用户填的**（32K~1M）。绝对值在小窗口上会算出负数线（32_000−20_000−13_000 = −1_000 → 每轮都判"该压"）。这不是换机制：判定量、比较关系、四道线的相对位置全不变，只是把"减多少"从绝对数换成同一比例的数。源码本来就有百分比路（`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`），这里把它提为默认 |
| **A24** | §12 | 输出预留固定 `min(模型最大输出, 20_000)` | 再加一道守卫：预留**不超过窗口的一半** | 窗口 ≤ 40_000 时预留会吃掉整个窗口（eff ≤ 0），比例式就没有分母了。守卫只在极小窗口上生效，200K 上结果与 cc 完全一致 |
| **A25** | §12.1 | 源码没有"档位"概念，窗口由模型名/能力表决定 | 加 `resolveContextWindow({contextWindowTokens, contextWindowProTokens, tier, model})`：**按档位解析**，pro 档可单独覆盖 | 本产品是双档模型配置（`models.ts:109` 的 `RoleTier`、`sys_settings.model_pro` + `role_models`），pro 档模型名带 `[1m]`，两档窗口差一个数量级。不按档位解析 ⇒ 切档后百分比打在错误的底数上（1M 档按 128K 的线压，或反过来按 1M 的线压 128K 档 → 后者会越窗） |

---

## 4. 抄不到的部分（**说清楚边界，不猜**）

| 源码文件 | 状态 | 本移植怎么办 |
|---|---|---|
| `services/compact/cachedMicrocompact.ts` | **不在 checkout 里**（只在 `microCompact.ts:56-69` 被 `await import('./cachedMicrocompact.js')` 动态引用；`glob` 找不到文件） | 保留调用点的**门控与编排形状**（`isCachedMicrocompactEnabled` / 模型支持 / 主线程三道门、返回 `pendingCacheEdits`、取最后一条 assistant 的 `cache_deleted_input_tokens` 当基线、边界消息延后到响应之后、**不改本地消息**），函数体按源码注释里写明的语义实现（count-based 阈值），并把 `triggerThreshold` / `keepRecent` 改成**必须注入**——**没有编造任何默认数字**。测试只断言"配置可注入、未注入则不生效" |
| `services/compact/reactiveCompact.ts` | **不在 checkout 里**（`query.ts:15-16` 等处的动态 `require`） | 不移植。它的兜底动作 `truncateHeadForPTLRetry`（`compact.ts:243-291`）在 checkout 里，已原样移植并用于 `compactConversation` 的 PTL 重试环 |
| `services/contextCollapse/index.ts` | **不在 checkout 里**（`autoCompact.ts:217-218` 动态 require） | 不移植（feature 恒 false，门控分支保留在 `shouldAutoCompact` 的注释里） |
| `services/api/promptCacheBreakDetection.ts` 的 `notifyCompaction` / `notifyCacheDeletion` | 模块存在，但语义是"重置缓存折断检测的基线"（观测用） | 保留**调用点位置**与注释；本仓库没有该检测器，故不引入 |
| `bun:bundle` 的 `feature()` | 编译期宏，无法读 | 用常量表给出**外部构建**取值（见 A6） |
| `getModelCapability()` 的服务端能力表 | 运行时远程数据，不在仓库里 | 去掉该分支（见 A3） |
| `ensureToolResultPairing` | 只有引用（`claude.ts:1136`），函数体不在 compact 目录 | 不移植。它的**不变式**由 `adjustIndexToPreserveAPIInvariants`（在 checkout 里）覆盖 |

---

## 5. 接线契约（接进 `graph.ts` 的人看这一节）

### 5.1 调用点

`runToolLoop` 的发车处（现在是 `graph.ts:826-835` 的 `pruneHistory(history)`），换成：

```ts
// ① 适配：扁平 history → cc 形状消息（含 tool_use/tool_result 配对）
const messages = historyToMessages(history);
// ② 量：源码的 CANONICAL 口径（最后一次 API usage + 其后新增的估算）
const used = tokenCountWithEstimation(messages);
// ③ 判定：与源码同一套阈值（默认 167_000 / 180_000 / 177_000）
const warning = calculateTokenWarningState(used, model);
// ④ 自动压缩（自带熔断器与会话记忆优先；内部会跑微压缩的前置路径）
const r = await autoCompactIfNeeded(messages, host, model, "repl_main_thread", tracking);
```

`pruneHistory` 必须**在同一个改动里退役**（它原地改 history 中部；与"整份替换"的新语义并存会互相打架）。
**✅ 已退役（9/17）**：`pruneHistory` 及其四个常量与 `tests/history-prune.test.ts` 的前两组已一并搬走
（同文件里 `clipArgsForModel` 的三条断言**原样保留**，搬到 `tests/clip-args.test.ts`）。
接线落点不是把上面那段代码直接抄进 `runToolLoop`，而是抽成 `developerAgent/contextCompaction.ts`
的一个函数（`runContextGuard`）——`runToolLoop` 里只留一次调用，方便单测与"不接线"回退。见 §5.7。

### 5.2 要注入什么（`CompactHost`）

| 字段 | 传什么 |
|---|---|
| `summarize` | `createRealLlm` 的一次调用，用 `buildSummaryRequest()` 造好的请求。**注意**：system 提示词用请求里的那句（不是 developer 的 system prompt），且这一步要按 `querySource: 'compact'` 记账——它同样占 LLM 预算 |
| `getTranscriptPath` | 本仓库的原始日志/台账路径（`runs/...` 或台账 db 路径），会出现在摘要消息正文里 |
| `readFileState` | 需要回灌的"最近读过的文件"表（`{path: {content, timestamp}}`）。**压缩后它会被清空**（源码同款语义） |
| `readFile` | 读盘端口；不注入 = 不回灌任何文件 |
| `preCompactHooks` / `sessionStartHooks` | 可省 |
| `ids` | 只在测试里传；生产省略即用 `randomUUID()` / `new Date().toISOString()` |

### 5.3 台账要追加什么

```ts
// 压缩事件本体（字段 = cc 的 tengu_compact，compact.ts:650-695）
o.ledger.appendEvent("context_compacted", compactEventPayload(result, {
    isAutoCompact: true, recompactionInfo,
}));
// 熔断器状态（必须持久化，否则续跑会丢掉"连续失败几次"，
// 源码 autoCompact.ts:51-60 的 AutoCompactTrackingState 就是为跨轮携带而存在的）
o.ledger.appendEvent("autocompact_tracking", {
    compacted: true, turnCounter, turnId, consecutiveFailures: r.consecutiveFailures ?? 0,
});
```

### 5.4 应用压缩结果

```ts
const { history: nextHistory } = applyCompactionToHistory(history, r.compactionResult);
history.splice(0, history.length, ...nextHistory);   // history 是 const，就地替换内容
```
**整体替换，不要改中部**——`buildPostCompactMessages` 的顺序就是"压缩后模型看到什么"的全部定义。

### 5.5 窗口从哪读进来（**产品接线面，逐处写清**）

窗口是**用户输入**，不是常量。链路已经有一半现成：

```
Web 设置页  →  MySQL sys_settings（id=1 单行）  →  settings.ts refreshSettings()（30s TTL 热重载）
            →  runtimeSettings()（同步读缓存）  →  resolveContextWindow(...)  →  传给 autoCompactIfNeeded
```

**① 建议新增的字段名**（沿用该表已有的 snake_case 命名：`model_name` / `model_pro` /
`role_models` / `confirm_timeout_min` …）：

```sql
ALTER TABLE sys_settings
  ADD COLUMN context_window      INT NULL COMMENT '上下文窗口最大值(token)；空=未配置，引擎按产品默认 256000 并告警',
  ADD COLUMN context_window_pro  INT NULL COMMENT 'T3 pro 档的上下文窗口(token)；空=回落到 context_window';
```
设置页两个输入框：**「上下文窗口（token）」** / **「上下文窗口 · pro 档（token）」**。
两者都留空时引擎会喊一行告警（见 §0.1），所以"没填"是可观测的，不会被当成 1M。

**② 在 `settings.ts` 里加两行**（`refreshSettings()` 那个 `cached = {...}` 对象里，`:50-63`）：
**✅ 已落地（9/17）**——不是"加两行"而是抽成了一个**纯函数** `readContextWindowColumns(row)`，
理由：列**还没建**（`ALTER TABLE` 是另一件事）时这条路径必须"读不到就退回下一步、绝不抛，
也不静默变 0"，而纯函数才进得了单测（DB 不在测试环境里）：

```ts
// settings.ts
export function readContextWindowColumns(row): { contextWindow: number | null; contextWindowPro: number | null } {
    return { contextWindow: Number(row["context_window"] ?? 0) || null,
             contextWindowPro: Number(row["context_window_pro"] ?? 0) || null };
}
// refreshSettings() 里：const window = readContextWindowColumns(r); cached = { ..., ...window };
```
注意 `Number(...) || null` 的口径与同文件其它数值列一致（**0/空/垃圾 → null = 未配置**）：
`"128k"` 走 `Number` 得 NaN → null（**坏数据当没配**，比猜一个数安全），
`resolveContextWindow` 还会再解析一次。

**③ 引擎侧的读取点**：**✅ 已落地（9/17）**——`developerAgent/index.ts` 的
`resolveDeveloperContextWindow({ llmId, role, tier, model, rt })`（导出、可单测）解析**一次**：
档位走 `resolveRoleTier(role, rt.roleModels)`，模型名按"实际客户端 → `model_name`（pro 档再顶
`model_pro`）→ env"取，然后 `resolveWiredContextWindow` 出 spec；spec 随 `DeveloperGraphDeps`
→ `runToolLoop` → `autoCompactIfNeeded`。**闸内不再解析**（`ContextBudgetOption.window`）。
`rt` 取 `runtimeSettings()`（同步读 30s 缓存，**不查库、不 await、不抛**）：null（库没起/表空/
缓存未填）或两列为 null 时直接落 ③④⑤ 步。

```ts
import { resolveRoleTier } from "./models";
import { runtimeSettings } from "./settings";
import { resolveContextWindow } from "./developerAgent/contextBudget";

const rt = runtimeSettings();
const role = /* 本次节点的角色，如 "backend" / "architect" */;
const tier = resolveRoleTier(role, rt?.roleModels ?? null);        // models.ts:117
const windowSpec = resolveContextWindow({
    contextWindowTokens: rt?.contextWindow,                        // ① 全局基准
    contextWindowProTokens: rt?.contextWindowPro,                  // ② pro 档覆盖
    tier,                                                          // 哪一档
    model: /* 该档位生效的模型名，即 resolveModelConfig(...).model */,
});
// 传给 runToolLoop → 再传给 autoCompactIfNeeded(messages, host, windowSpec, ...)
```
`model` 一定要传**该档位生效的那个名字**（`models.ts:86-88` 的 T3 合并产物）：
pro 档名字里的 `[1m]` 是"这台是 1M"的声明，漏传就会退化成产品默认 256000（并告警）。
⚠️ 落地时的取舍：`index.ts` 的 `resolveDeveloperContextWindow` 把**实际在用的客户端**
（`llm.id`）排在 `model_name` / `model_pro` **之前**——按设置里写的名字算窗口、实际却用另一个
模型跑，等于凭空假设一个更大的窗口 ⇒ 压缩触发过晚 ⇒ 越窗 400（`dotenv.ts` 的实测教训同源）。
两者不一致本身是"配置没生效到这条线上"的信号，台账里的 `model` 字段会如实暴露它。

**④ 台账**：把 `{ windowSpec.contextWindowTokens, windowSpec.source, windowSpec.degraded, windowSpec.tier, windowSpec.model }`
随 `context_compacted` / `autocompact_tracking` 一起落一条（`degraded === true` 时就等于
"这一轮是在猜的窗口上跑"，事后复盘必须看得见）。
**✅ 已落地（9/17）**：五个字段由 `contextCompaction.windowProvenance(spec)`（唯一出处）统一注入，
落在**每一条**上下文事件上：`context_compacted`、`autocompact_tracking`（成功/失败两行）、
`context_compaction_failed`、`context_request_blocked`、`context_window_resolved`。
单测钉着"两条主事件都带这五个名字"以及"degraded 那一轮必须显式 degraded=true"。

**⑤ 自检**：改设置页 → 30s 内（`settings.ts:41` 的 TTL）新的窗口生效；
`runtimeSettings()` 为 null（DB 没起/表为空）时**不报错**，按 `.env`／产品默认 256000 继续（并告警）——
这条旁路原则是 `settings.ts:8` 定的，别破坏。

### 5.6 其余配置（env，名字与 cc 一致）

`CLAUDE_CODE_AUTO_COMPACT_WINDOW`、`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`、
`CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE`、`DISABLE_COMPACT`、`DISABLE_AUTO_COMPACT`、
`CLAUDE_CODE_MAX_OUTPUT_TOKENS`、`CLAUDE_CODE_MAX_CONTEXT_TOKENS`、
`ENABLE_CLAUDE_CODE_SM_COMPACT`、`CF_TENGU_SLATE_HERON`（替换 GrowthBook 的 `tengu_slate_heron`）。

⚠️ **微压缩默认是关的**（源码 `timeBasedMCConfig.ts:30-34` 的 `enabled: false`）。
要开就 `setTimeBasedMCConfig({ enabled: true })` 或设 `CF_TENGU_SLATE_HERON`——
**这是配置选择，不是移植的一部分**。

### 5.6 自检清单

- [x] `bunx tsc --noEmit` 退出码 0
- [x] `bun test developerAgent/tests/` 与 `bun test tests/` 的 pass/fail 与接线前**逐条对比**（见 §5.7 末行）
- [x] 退役 `pruneHistory` 调用，`tests/history-prune.test.ts` 同步搬走
- [x] 台账里能看到 `context_compacted` 的 `preCompactTokenCount / autoCompactThreshold / willRetriggerNextTurn`（另加五个窗口出处字段）
- [ ] 一次真机跑里：`context_compacted` 的次数 = 边界标记 `compact_boundary` 的出现次数
      （每个边界对应一次真实压缩；没有边界就不该有压缩事件）
      ——**唯一未做项**：需要一次真实运行（禁跑真机/网络），单测只能验到"台账行数 ≡ 前缀版本 ≡ 摘要调用次数"

### 5.7 接线**实际完成情况**（9/17，落地记录：上面是契约，这一节是"读代码的人往后怎么找"）

| 契约条目 | 实际落点 |
|---|---|
| §5.1 调用点 | `graph.ts` 的 `runToolLoop`：**预占额度之前**跑一次 `contextCompaction.runContextGuard()`（不传 `contextBudget` 时整段跳过）；旧 `pruneHistory` 那一处已删 |
| 接线壳 | **`developerAgent/contextCompaction.ts`**（新文件）：窗口解析、判定（`planContextAction` / `canSendLlmRequest`）、台账写入、熔断器读回、`CompactHost` 组装 |
| §5.2 `summarize` | `realLlm.ts` 的 **`createRealLlmSummarizer`**（`createRealLlm` 把它挂在返回值的 `summarize` 上）；`live/hub-runner.ts` / `live/runner.ts` 的懒建包装器都转发 `summarize` → 生产一定有摘要口 |
| §5.3 台账 | `context_compacted`（字段 = `compactEventPayload` + `prefixVersion` / `compactionId` / 窗口 provenance）、`autocompact_tracking`（熔断器，**读回**靠 `readAutoCompactTracking`）；另有 `context_window_resolved`（degraded 告警原文）、`context_compaction_failed`、`context_request_blocked`、`context_guard_failed` |
| §5.4 应用结果 | `applyCompactionToHistory` → 调用方 `history.splice(0, history.length, ...next)`（整份替换） |
| 越阻塞线 | **不发、不截断**：`state.contextBlocked` → `routeAfterImplement` / `routeAfterLocalChecks` 出口 → `escalate` 节点组四段题（新 `AskReason = "CONTEXT_OVERFLOW"`）→ `waiting_human` → `index.invokeWithHuman` 现有问答通道回填答案复活（**没有第二套通道**） |
| §5.5 窗口 | **已落地**：`index.ts` 的 `resolveDeveloperContextWindow`（导出、可单测）解析**一次**——`resolveRoleTier(role, rt.roleModels)` 定档、模型名按"实际客户端 → `model_name`/`model_pro` → env"取、`sys_settings.contextWindow/contextWindowPro` 作为 ①② 优先级传入，再 `resolveWiredContextWindow` 出 spec 并随 deps 传进 `runToolLoop`（`ContextBudgetOption.window`，闸内不再解析）。`settings.ts` 用纯函数 `readContextWindowColumns` 读那两列（**列还没建 → null → 回落下一步，绝不抛**，有单测）。DB 列 + 设置页 UI 仍是另一件事 |
| 窗口出处（owner 规格） | `contextCompaction.windowProvenance(spec)` 唯一出处，把 `{contextWindowTokens, source, degraded, tier, model}` 注入**每一条**上下文事件（压缩/熔断器成功与失败/压缩失败/阻塞/告警）——`degraded:true` 的轮次其阈值**不可**与已配置的轮次对比，这条链靠这五个字段才成立 |
| 版本号 | **`prefixVersion` ≡ 台账里 `context_compacted` 的行数**（跨 resume 可复原；一次真实压缩恰好 +1） |
| 单测 | `developerAgent/tests/context-wiring.test.ts`（26 条：阈值从窗口推出、整份替换与前缀版本、台账两行、熔断器跨 resume、越窗问人、摘要调用记账、不接线回退、**设置列缺失/垃圾值的安全降级**、**装配处一次解析（档位×模型名）**、**窗口出处五字段可审**） |
| 套件计数（9/17 接线后） | `bun test developerAgent/tests/` 862 pass / 0 fail；`bun test tests/` 946 pass / 0 fail；`bunx tsc --noEmit` exit 0 |
