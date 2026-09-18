# CrewForge 前端设计 · 晒图室（THE ROLL / The Drawing Office）

> 9/17 整间重塑（impeccable 方向种子 89b0257e）。一句话世界：**AI 软件团队是一屋子绘图员——
> 经理接单登记、架构师铺图板、开发画图、测试盖红圈、老板翻台账。** 界面不是"仪表盘"，是一间晒图室。
> 范围：八个活跃页（登录 / 台账 / 新建 / 详情 / 绘图桌 / 执行面板 / 工单板 / 验收与证据）。
> 9/18：TeamView、AgentRepository、AgentForm 三张封存图纸已删（连 element-plus 一起）。

## 1. 纸面（色彩）

| 角色 | Token | 值 |
|---|---|---|
| 纸 | `--paper` / `--paper-raised` / `--paper-deep` | #e9eef2 / #f3f6f8 / #dde5eb |
| 墨 | `--ink` / `--ink-2` / `--ink-3` | #16222e / #46586a / #5f7280 |
| 图线 | `--line` / `--line-2`；蓝图格线 `--grid`（`body::before`） | #b9c6d1 / #8fa3b3 |
| 晒图青 | `--cyan` #155e93 一家：`--cyan-deep` / `--cyan-wash(-2)` / `--cyan-plate` #0e3a5c（执行面板活动栏深板） | — |
| 图章 | pass #2e8f5b · void #c23a2e · wait #d98f1b · pencil #5f7280 · rust #a05a2c · **indigo #7a4fb5**（各配 -ink 深字版；上表列的是章面亮色，indigo 的 -ink 是 #54307f） | — |

> **9/18 加第 7 个章色「靛紫」（indigo）**：状态有 7~8 个、章色只有 6 个，必然撞色。原先
> 「草稿」与「规划中」都是铅笔灰 —— 台账上**两个状态肉眼分不开**（用户实测反馈："草稿/规划中/执行中没颜色区分"）。
> 现在 **草稿=灰 / 规划中=紫 / 执行中=青**。
>
> **为什么是"紫"而不是"靛蓝"**：第一版取偏蓝的 `#33408a`，实测与晒图青 `#155e93` 亮度比只有 1.36:1、
> 色相也都在蓝区，在 7px 色点上依旧难分 —— 等于没修。改成紫之后：紫 267° vs 灰/青 205°，
> **色相各隔 62°**，小尺寸下才真的可辨（`--indigo-ink #54307f` 对纸白 8.54:1，过 AA）。
>
> ⚠️ 已知边界（如实记录）：**草稿灰与执行中青的色相相同（都是 205°）**，只靠饱和度区分
> （灰 vs 蓝）。这是"青专属执行中"这条纪律的代价；要彻底分开得再动 `--pencil`，
> 而那是个全站通用的墨三级 token，改它影响面大，留待单独评估。
> 另外 `pencil #5f7280` 对纸白只有 **4.27:1**，不到 AA 的 4.5:1（章面是粗体大字，按大字号 3:1 标准是过的）。
>
> ⚠️ `tone` 的联合类型在**两处**：`constants/status.ts` 的 `StampTone` 与 `components/ui/StampSeal.vue`
> 的 prop。**加色必须两处同改**，否则任何用到新色的页面都会 TS 编译不过（9/18 实测踩到，3 个页面红）。
> 台账筛选栏的状态色点走 `.stamp-{tone}`（与列表行的状态章同一份 token），所以点与章天然同色。

### 1.1 受控例外：`.vsc-dark`（9/18）

执行面板是**工作台**不是图纸：它要装 VS Code 默认暗色（Dark+）的编辑器、文件树、日志。
做法是在 `style.css` 里开一个 `.vsc-dark` 作用域重绑 `--paper* / --ink* / --line* / --cyan*`
到 Dark+ 原值，而不是逐组件写死色。规矩：

- **只准执行面板用**。进这个作用域的组件（Monaco / FileTree / 日志窗 / AppModal `tone="dark"`）
  必须完全靠 `var()` 取色；任何硬编码 `#fff` / `#1e1e1e` 都是越界。
- 一进一出要成对：外层 `.exec.vsc-dark`，`Teleport` 出去的弹窗要自己带 `scrim vsc-dark`
  （Teleport 会切断 CSS 变量继承，9/18 踩过）。
- **不要用 `:where()`** 降特异性：`.vsc-dark` 里的重绑会被后面的浅色规则反杀。
- `--cyan` 在这套暗底上对比度不够，需要的地方取 `--cyan-ink`。

## 2. 字面（Type）

- **Oswald**：页名、图号、格标签、按钮（图纸上的工业字面）
- **JetBrains Mono**：路径、编号、接口报文、日志
- **system-ui**：正文。字号阶：`--fs-sheet` clamp(34,5vw,56) / h1 26 / h2 17 / body 14 / meta 12
- 圆角只有三档：`--r-xs 2 / --r 4 / --r-lg 8`——图纸世界没有大圆角

## 3. 通用件（`style.css` 原子 + `components/ui/`）

| 件 | 干什么 |
|---|---|
| `TopBar` | 图签顶栏：logo ｜ 上下文槽（页名+图号+状态章）｜ 动作槽。≤480 字标让位保图章入框 |
| `.sheet-no` | 图号（ARCH-0001-D 这种），永不折行 |
| `StampSeal` / `.stamp` | 盖章节点章：tone 联合类型见 `constants/status.ts`（pass/void/wait/info/pencil/rust），盖下动画 `stamp-press` |
| `.tblock` | 标题栏条（Sheet No./Scale/第几张…），≤480 自动折 2×2 |
| `.lamp` | 信号灯（on/wait/void/cyan/live），"引擎运行中"的心跳 |
| `.panel` `.rows` `.row` | 图框卡与账簿行——**列表优先于行内卡片**，卡片只在真有层级时用 |
| `.revision-cloud` | 红圈云 = 错误态专用（台账取不到数时圈起来重画），配 void 色 |
| `.empty-sheet` | 空态纸：讲清怎么把这张纸填满 |
| `.skeleton` | 骨架按最终形状画，不给转圈 |
| `AppModal` | 弹窗（技术选型器、任务详情用） |
| toast / confirm | **自研总线** `utils/toast.ts`、`utils/confirm.ts`——EP 的 ElMessage/ElMessageBox 已全部退役 |

## 4. 动（Motion）

缓动 `--ease cubic-bezier(.16,1,.3,1)`；`--dur .16s` / `--dur-slow .42s`。
`sheet-fall` 进页落纸、`.route-enter-*` 只做入场不做退场、盖章用 `stamp-press`——
动效只回答"什么变了"，不表演。`prefers-reduced-motion` 全停。

## 5. 状态与数据纪律

- 轮询统一 `composables/usePolling`（10s 一档，**拿到 start 就必须调用**，卸载自清）
- 看板唯一数据源 `sys_task`；`cf_token` / `cf_confirm_mode` / `cf_files_{id}` 三个 localStorage 键名冻结
- 所有 mock 台词、确认卡文案、错误信息逐字保留旧页——只换皮，不换嘴
- 状态 label/tone 只在 `constants/status.ts` 一处定义（MODE_META 是引擎行为描述，禁文学化改写）

## 6. 真图（占位符就位中）

生图清单在 **`ASSETS-PROMPTS.md`**（v2，尺寸按 CSS 真实渲染盒子反推）。**只剩 6 张**：

| 文件 | 渲染尺寸 | 用在哪 |
|---|---|---|
| `sheet-login-flow.png` | 60% × 100dvh（`cover`） | 登录页左版 |
| `sheet-empty-draft.png` | 220px 宽 | 台账空态 |
| `agent-manager.png` | 28 / 48px 圆 | 对话头像 · 确认卡 |
| `agent-architect.png` | 30px 圆 | 绘图桌 |
| `logo-crewforge.png` | 26×26 | 顶栏 |
| `logo-crewforge-cyan.png` | 34×34 | 登录页蓝版上 |

**按同名替换即可点亮，代码零改动。** 9/18 已把代码零引用的死图全删了
（`bg-login` / `hero` / `banner-agents` / 只被已删封存页用的 4 张 `agent-*`），
`src/assets/` 与上表一一对应。

## 7. element-plus：已彻底拔除（9/18）

`package.json` 无依赖、`main.ts` 无 import、`src/` 里零引用（只剩注释里提到它）。
那三张"封存页"（TeamView / AgentRepository / AgentForm）也一并删了 —— 它们自 9/15 起
就被路由守卫拦成"功能未开放"，界面永远进不去，留着只是 1700 行死代码 + 一个死依赖。

**真要恢复某天的话**：`npm i element-plus` → 组件里 `import { ElMessage } from 'element-plus'`
→ 别忘了同时 `import 'element-plus/dist/index.css'`（EP 样式不带副作用引入）。
`utils/toast.ts` / `utils/confirm.ts` 是自研总线，跟 EP 不冲突，可以共存。

⚠️ **这台机器没外网**（`registry.npmmirror.com` 连不上，`npm i` 会 ENOTCACHED 失败），
`pnpm store path` 指向的 `CrewForge/.pnpm-store/v11` 是**空的**。唯一可能离线还原的途径
只剩 `node_modules/.pnpm/element-plus@2.14.5_*/` 那份残留副本。**真要恢复 EP 之前先把它拷出去**，
否则下一次 `pnpm install` 之后它就真没了。
