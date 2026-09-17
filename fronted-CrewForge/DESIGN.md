# CrewForge 前端设计 · 晒图室（THE ROLL / The Drawing Office）

> 9/17 整间重塑（impeccable 方向种子 89b0257e）。一句话世界：**AI 软件团队是一屋子绘图员——
> 经理接单登记、架构师铺图板、开发画图、测试盖红圈、老板翻台账。** 界面不是"仪表盘"，是一间晒图室。
> 范围：六个活跃页（登录 / 台账 / 新建 / 详情 / 绘图桌 / 执行面板）；
> TeamView、AgentRepository、AgentForm 三张图纸**封存未改**，等旧皮恢复。

## 1. 纸面（色彩）

| 角色 | Token | 值 |
|---|---|---|
| 纸 | `--paper` / `--paper-raised` / `--paper-deep` | #e9eef2 / #f3f6f8 / #dde5eb |
| 墨 | `--ink` / `--ink-2` / `--ink-3` | #16222e / #46586a / #5f7280 |
| 图线 | `--line` / `--line-2`；蓝图格线 `--grid`（`body::before`） | #b9c6d1 / #8fa3b3 |
| 晒图青 | `--cyan` #155e93 一家：`--cyan-deep` / `--cyan-wash(-2)` / `--cyan-plate` #0e3a5c（执行面板活动栏深板） | — |
| 图章 | pass #2e8f5b · void #c23a2e · wait #d98f1b · pencil #5f7280 · rust #a05a2c（各配 -ink 深字版） | — |

⚠️ **血案纪律**：`style.css` 尾部"旧名喂新值"别名块只许 `--旧名: var(--新值)`；
`--cyan: var(--cyan)` 自引用会让整间屋子的青色当场失效（9/17 截图实锤，全站主按钮变隐形）。

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

生图提示词（文件名+英文 prompt）：**桌面 `CrewForge-晒图室-生图提示词-20260917.md`**。
当前 `src/assets/` 里同名文件为 `.impeccable/gen-placeholders.ps1` 生成的蓝图线稿占位：
agent-architect / agent-manager / agent-backend / agent-frontend / agent-tester / agent-maintainer、
logo-crewforge(-cyan)、banner-agents、bg-login、hero、sheet-login-flow、sheet-empty-draft。
**按同名替换即可点亮，代码零改动。**

## 7. 恢复 element-plus（如果哪天要）

`main.ts` 已无 EP import；三张封存页各自引样式仍活。恢复路径：SheetTree/FileTree 换回
`el-tree` → `package.json` 删 element-plus → `style.css` 删旧名别名块。
