# CrewForge 晒图室 · 生图清单 v2（按渲染尺寸反推）

> **9/18 收敛**：三张封存页（TeamView / AgentRepository / AgentForm）已删，页面上每个 `<img>`
> 都数过了 —— 现在**只剩 6 张图要生成**：2 张场景图 + 2 张胸像 + 2 个 logo。
> 原本 6 张胸像里的 `agent-backend / agent-frontend / agent-tester / agent-maintainer`
> 只有封存页引用，已随页面一起删掉；`banner-agents.png` 同理，不做。
> 下面的提示词保留原文，但**只有标 ✅ 的需要生成**。

> **为什么有 v2**：v1 的尺寸规格和代码里的真实渲染盒子对不上。素材不是"画得好不好"的问题，
> 是**照 v1 生成出来就会白做**——登录版会被双边裁掉近三成、Agent 胸像的细节在 28px 下全糊成噪点、
> 6 张 1MB 的图用来显示 28px 头像。下面每个数字都是从 CSS 里量出来的，不是我估的。

---

## 0. 先看这张表：v1 → v2 改了什么

| 资产 | v1 规格 | 代码里**真实渲染** | v2 规格 | 收益 |
|---|---|---|---|---|
| ✅ `sheet-login-flow.png` | 2400×1600（1.5） | `.plate-img`：`60% × 100dvh` + `object-fit:cover` → 宽高比 **0.80（4:3）～1.40（21:9）**，16:9 时 **1.067** | **1600×1600** | 消除约 **29% 的双边裁切**，右下预留区不再错位 |
| ✅ `sheet-empty-draft.png` | 1200×900 | `.empty-img`：**width 220px** | **1000×750** | 够用；细节按 220px 反推 |
| ✅ 2× `agent-{manager,architect}.png` | 1024×1024 | **28×28**（`.msg-avatar img`）· **30×30**（Architect）· **48×48**（`.pm-avatar`），全部 `border-radius:50%` | **256×256** | 尺寸 -94% |
| ❌ 4× `agent-{backend,frontend,tester,maintainer}.png` | 1024×1024 | **代码 0 引用**（只被已删的封存页用） | **不做** | 省 4 次生成 |
| ✅ `logo-crewforge.png` | 1024×1024 | `.tb-logo`：**26×26**，`contain` | **256×256** | 42KB → ~8KB |
| ✅ `logo-crewforge-cyan.png` | 1024²（可选） | `.plate-logo`：**34×34**，`contain` | **256×256** | 同上 |
| ~~`bg-login.png`~~ | 清单里没有 | **代码 0 引用** | **已删** | 清掉 120KB 死资产 |
| ❌ `texture-cyanotype.png` | 可选 | **代码 0 引用** | **不做** | 省一次生成 |
| ❌ `plate-detail-ornament.png` | 可选 | **代码 0 引用** | **不做** | 省一次生成 |
| ~~`banner-agents.png`~~ | — | 仅封存页 CSS（`AgentRepositoryView.vue:285`） | **已删（页也没了）** | — |

---

## 1. 硬约束（照做，别商量）

1. **图内不许出现任何可读文字／字母／数字／水印。** 生图模型写字必糊。图号、标题栏、状态章全部由 HTML 叠上去。
2. **只用这四个色**：普鲁士蓝 `#155e93` 系、纸白 `#e9eef2`、墨 `#16222e`、淡青 `#9fc6e8`。不要彩虹色、不要粉紫、不要照片写实。
3. **只有两个 logo 需要透明背景**（带 alpha 的 PNG）。其余一律不透明——透明图在纸白底上看不出问题，在深蓝图版上会露出方块。
4. **每张图都有安全区要求**（下面逐条写）。因为 CSS 会裁切，把重要内容画到边缘 = 白画。

---

## 2. 逐张提示词（整段复制英文）

### 2.1 `sheet-login-flow.png` — 1600×1600 · 不透明 · 登录页大图版

登录页左侧 60% 的蓝晒流水线图版。**尺寸从 2400×1600 改成近方形**，因为容器宽高比是 0.80～1.40，原图 1.5 会被双边各裁约 345px，而这张图的叙事恰恰是"从最左的图纸流向最右的圆章"——头尾正好被切掉。

```
Cyanotype blueprint technical drawing, full-bleed deep Prussian blue background (#155e93 range), fine white and pale-cyan (#9fc6e8) drafting line art only. A large engineering drawing of an abstract software production line reading left to right along the horizontal centre band: a single document sheet at the left flowing through a sequence of connected workstations drawn as orthographic technical diagrams (tables, racks, assembly blocks), joined by dimension leader lines, arrows and dashed conveyor paths, ending at the right in a large circular seal outline and a square approval stamp outline. Add a compass rose, a scale ruler strip, section markers and exploded detail callouts with thin leader lines. Composition rules, important: keep every narrative element inside the central 80 percent of the width and the central 75 percent of the height; keep the outer 12 percent margin almost empty with only faint grid and tick marks, because this image is centre-cropped to fill a tall panel and the edges will be cut; keep the bottom-right area inside that safe margin free of detail, reserved for an overlaid title block. Strict technical lettering style, crisp vector-like line weights with a few clearly bold outlines, flat 2D orthographic, no perspective, no gradients, no glow, absolutely no text no letters no numbers no watermark, no photorealism. Industrial drafting, mid-century engineering print, precise, beautiful.
```

### 2.2 `sheet-empty-draft.png` — 1000×750 · 不透明 · 空状态插图

渲染宽度只有 **220px**，所以细节必须为缩略图反推。

```
A mostly blank engineering drawing sheet viewed flat, cool off-white drafting paper (#e9eef2) with a very faint blue grid, a thin double-line border frame with corner tick marks, one small corner area half-drawn in fine pencil-gray construction lines (a simple machine block outline with two leader lines), faint eraser smudges, and a blank empty title-block rectangle in the bottom-right corner drawn in thin lines. Minimal, quiet, lots of empty paper. Legibility rule: the whole drawing must stay readable when scaled down to 220 pixels wide, so use few clearly separated shapes with generous spacing, no fine hatching and no dense texture. Flat 2D technical illustration, crisp linework, muted cool palette only (paper white, graphite gray, pale Prussian blue #155e93 accents), absolutely no text no letters no numbers, no photorealism.
```

### 2.3–2.5 两张 Agent 胸像 — 256×256 · 不透明（原 6 张，现只需 2 张）

**这一组是 v1 错得最狠的**：v1 要求"方形深蓝底 + 外圈细线框 + 铆钉点"，但代码里是 `border-radius:50%` 圆形裁切、渲染尺寸 **28px**。结果：

- 方底四角**会被 CSS 圆整个切掉** → 画了没人看见；
- "双线圈 + 铆钉"在 28px 下是**亚像素** → 只会变成摩尔纹噪点。

v2 的统一风格锚（6 条已内嵌，不用单独贴）：

```
Cyanotype badge portrait on a square canvas. A deep Prussian blue (#155e93) disc centred and filling about 94 percent of the frame, leaving a thin dark-navy (#0e3a5c) rim visible at the outer edge; the four corners of the canvas are that same dark navy and will be clipped away by CSS, so leave them plain and undetailed. Inside the disc, a bust portrait drawn in bold white drafting line art, geometric engraved-stamp style face. Critical legibility rule: this badge is displayed at 28 pixels, so it must read as a pure silhouette — one simple head-and-shoulders mass in white on blue, large flat shapes, generous empty space, plus exactly ONE oversized distinctive prop. No interior detail, no rivets, no double rings, no hatching, no fine texture; at most one single thin ring near the disc edge. Flat 2D, crisp thick-and-thin linework, no gradients, absolutely no text no letters no numbers, no photorealism.
```

**在风格锚后面各接一句（其余照抄上面的锚）：**

| 文件 | 追加的英文句 |
|---|---|
| ✅ `agent-manager.png` | `The figure is a project manager: short neat hair, a high collar, holding one large clipboard board squarely in front of the chest, a T-square tucked under the opposite arm. Calm authoritative posture.` |
| ✅ `agent-architect.png` | `The figure is a systems architect: small round glasses, one large rolled blueprint tube held diagonally like a shoulder strap, a drafting compass hanging from one hand. Thoughtful upright posture.` |
| ❌ `agent-backend.png` | `The figure is a backend engineer: a flat cap, and one large server rack block sitting on one shoulder like a pauldron with a single thick cable running down the chest. Sturdy solid posture.` |
| ❌ `agent-frontend.png` | `The figure is a frontend engineer: a soft beret, holding up one large rectangular window frame with crossed mullions beside the head, a paint roller resting at the collar. Light elegant posture.` |
| ❌ `agent-tester.png` | `The figure is a test engineer: safety goggles pushed up on the forehead, one large open vernier caliper held across the chest like a measuring instrument. Precise attentive posture.` |
| ❌ `agent-maintainer.png` | `The figure is a maintenance engineer: a work cap, one large adjustable wrench raised over one shoulder, an oil can at the collar. Ready-to-fix posture.` |

> ❌ 四行的提示词留着备查，但**界面上已经没有任何地方放这四张脸**（原本只有已删的
> `AgentRepositoryView` 用），生成了也没人 import。

### 2.9 `logo-crewforge.png` — 256×256 · **透明背景（必须带 alpha）**

渲染尺寸 **26×26**，`object-fit: contain`——整张图缩进 26px 的盒子里。

```
Minimal engineering logo mark on a fully transparent background, centred in a square canvas with about 10 percent padding on all sides so nothing is clipped when scaled down to 26 pixels. A sheet corner (a square page with one folded corner) combined with a drafting triangle and a T-square forming a subtle letter F silhouette, drawn in solid ink navy (#16222e) with one accent element in Prussian blue (#155e93). Legibility rule: it is displayed at 26 pixels, so use bold simple shapes with only two or three line weights and no fine detail. Flat 2D vector style, geometric, perfectly balanced, no text no letters no numbers, no gradients, no photorealism.
```

### 2.10 `logo-crewforge-cyan.png` — 256×256 · **透明背景（必须带 alpha）**

给蓝晒图版用（`.plate-logo` 34×34，叠在深蓝版上）。

```
Same composition and same legibility rule as above, but rendered as white line art with one pale-cyan (#9fc6e8) accent instead of ink navy and Prussian blue, on a fully transparent background, centred with about 10 percent padding. Minimal engineering logo mark: a sheet corner with one folded corner combined with a drafting triangle and a T-square forming a subtle letter F silhouette. Bold simple shapes, only two or three line weights, flat 2D vector style, geometric, no text no letters no numbers, no gradients, no photorealism.
```

### 2.11 ~~`banner-agents.png`~~ — 已取消

它只被封存页的 CSS 引用（`AgentRepositoryView.vue:285`），而那张页 9/18 已删。**不做。**

---

## 3. v2 明确**不做**的三张

| 名字 | 为什么不生成 |
|---|---|
| `bg-login.png` | 代码**零引用**。登录页的背景是 `sheet-login-flow.png`（`.plate-img`），两个登录背景资产留一个就够。磁盘上那个 120KB 的死文件 **9/18 已删**。 |
| `texture-cyanotype.png` | 代码**零引用**（v1 自己写了"代码已做纯 CSS 兜底"）。格线是 `body::before` 纯 CSS 画的，生成出来也没人 import。 |
| `plate-detail-ornament.png` | 同上，零引用。 |

---

## 4. 生成完的自检清单（逐张过）

- [ ] **尺寸**对得上表里的数字（差一点没关系，比例别差）
- [ ] 图里**没有任何可读文字/字母/数字**（放大到 200% 检查，模型最爱偷偷塞字）
- [ ] 色相**只有**普鲁士蓝／纸白／墨／淡青，没有意外闯入的绿紫粉
- [ ] 两个 logo 是**带 alpha 的 PNG**（拖到深色背景上验证，没有白底方块）
- [ ] 2 张胸像缩到 **28px** 看一眼：**还能认出是谁吗？** 认不出就回炉——这条是唯一的硬指标
- [ ] `sheet-login-flow` 在**中央 80%×75%** 之外的边缘区域是空的（脑内模拟左右各裁 15%）
- [ ] 总体积：**6 张图合计应 < 400KB**；单张超 300KB 说明线太碎，回炉或压一下

**落地路径**（文件名必须一字不差，代码按这些名字占位）：

```
F:\code\project\CrewForge\fronted-CrewForge\src\assets\
  ├── sheet-login-flow.png      1600×1600  不透明  (覆盖)
  ├── sheet-empty-draft.png     1000×750   不透明  (覆盖)
  ├── agent-manager.png          256×256   不透明  (覆盖)
  ├── agent-architect.png        256×256   不透明  (覆盖)
  ├── logo-crewforge.png         256×256   透明    (覆盖)
  └── logo-crewforge-cyan.png    256×256   透明    (覆盖)
```

> 目录里现在正好就这 6 个文件，多的都是死资产（9/18 已按上表清过一轮）。

> 生图工具给不出精确尺寸没关系，代码会按容器裁切／缩放；**但上表的比例尽量守住**，尤其是胸像必须是正方形、登录版必须近方形。

---

## 附：配色 token 补丁（**改的是 CSS，不是图**，待批准后我再落地）

上面所有提示词里的色值 `#155e93` / `#e9eef2` / `#16222e` **都不变**，所以生图和这个补丁互不阻塞。

### A. 线色提到非文本 3:1（世界观是"线宽即层级"，但线现在在可见度阈值以下）

| token | 现值 | 对比度 | 建议 | 新对比度 |
|---|---|---|---|---|
| `--line`（0.5mm 面板描边） | `#b9c6d1` | **1.49:1** ❌ | `#728799` | **3.19:1** ✅ |
| `--line-2`（0.7mm 主描边/输入框） | `#8fa3b3` | **2.23:1** ❌ | `#6b8090` | **3.51:1** ✅ |

两档仍保持"0.5mm < 0.7mm"的轻重阶梯，只是整体下移到看得见的位置。

### B. 两个暖色靠明度分家（待检黄 vs 已暂停，现在几乎只能靠字形分辨）

| token | 现值 | 建议 | 新对比度 |
|---|---|---|---|
| `--wait-ink`（待检黄字） | `#8a5d10` 4.92:1 | **不动** | 4.92:1 |
| `--rust`（已暂停） | `#a05a2c` **4.50:1** | `#7d4a2a` | **6.23:1** |

`#7d4a2a` 仍是"铁锈"，但比 `--wait-ink` 明显更深，也和 `--void-ink #a93226`（红）拉开。

### C. 青色的"交互义"和"状态义"拆开 —— **这条要你拍板**

现状：`--cyan #155e93` 一个色同时当**主按钮／链接／选中／图号**和 **`planning`／`executing`／`stamp-info`**。
后果：**规划中和执行中同色**，只能读字；用户分不出"这能点"和"这是状态"。

8 个状态压 6 个章色，必然有两处撞色。两个方案：

**方案 A（零新增色，推荐）** —— 只拆操作员最需要一眼分辨的那一对：

| 状态 | 现在 | 改为 |
|---|---|---|
| `executing` 执行中 | info（青） | **info（青，不动）** |
| `planning` 规划中 | info（青） | **pencil（铅笔灰 #5f7280）** |
| 代价 | — | `draft` 与 `planning` 撞灰（都是"还没开工"）；`clarifying` 与 `blocked` 撞黄（都是"在等人/等验证"） |

**方案 B（加第 7 个章色"靛"给 `planning`）** —— 零撞色，但破了"六色章"的纪律，且要新增一个色值。
（`--violet` 那个废槽位 9/18 已从 `style.css` 删掉，选 B 就得重新加回来。）

我建议 A：免费、够用，而且修的是最要命的那一对。

---

## 附二：需要顺带修的文档 —— **9/18 已修完**

- `DESIGN.md` §6"真图"已改成直接指向本文件，并收敛成上面那 6 个名字；
- `hero.png`（只被已删的 Vite 脚手架 `HelloWorld.vue` 引用）**已删**；
- `bg-login.png`（代码零引用）**已删**；
- `banner-agents.png`（只被封存页用，页也删了）**已删**。

`src/assets/` 现在与上面"落地路径"那棵树逐一对应，没有多余的图。
