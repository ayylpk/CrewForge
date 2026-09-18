# Surface brief · CrewForge 控制台六页（App.vue + router + main.ts 挂载的全局表面）

范围：/login /projects /projects/new /projects/:id(/pm|/architect|/execution) 六活跃页 + 全局壳（顶栏/toast/确认门/弹窗）。封存三页不在本面。访客模式：Operate（操作员盯流水线），对外演示为第二读者。

## Direction contract

（seed key: 89b0257e · scope direction · mode operate · assigned 第4顺位 · buildPath=code-led）

THESIS：把整个控制台当成一套正在被持续下发的工程图纸——图号、标题栏、会签栏、验收章、修订云线就是界面本身。拒绝本品类默认脸（暗底+单一霓虹的运营仪表盘，即旧藏青口径）。

OWN-WORLD：冷调制图纸 #e9eef2 铺地，墨 #16222e 正文，晒图青 #155e93 承担结构色（30-60% 面积），章色三枚：验收红 #c23a2e / 待检黄 #d98f1b / 合格绿 #2e8f5b，只落在线条、细带与章面上。线宽即层级：0.25mm 辅助/网格、0.5mm 面板、0.7mm 主轮廓。图号大字 Oswald（self-host），数据/路径 JetBrains Mono，中文系统黑体。组件族：标题栏条、索引卡片、会签栏表单、圆角方章、修订云、硫酸纸浮层（backdrop 仅弹窗一处）。

STORY：访客三十秒内看懂：这是软件铸造厂，需求被画成图纸、图纸被 Agent 团队绘制、关键节点人工盖章放行、失败任务打修订云重画。操作员每屏回答：现在到哪、下一步、谁在动手、我能盖哪一章。

FIRST VIEWPORT：登录页=领图登记。左 60%：蓝晒流水线图版（资产 sheet-login-flow.png，载入时 mask 擦除式"晒图显影"一次），图版右下角叠真 HTML 标题栏（图号 PRJ-0000-A · 比例 1:1 · 第 1 张 共 1 张 · 晒图室 CrewForge）。右 40%：会签栏式登录表单（账号/密码/进入工作台按钮），回车即提交。无 eyebrow、无渐变字、无玻璃。<900px 图版退为顶部 34vh 横条。

FORM：晒图室图纸工作间 = 我按共鸣度排序的第 4 顺位（顺序：①安灯车间 ②ATC 进近束 ③列车运行图 ④晒图室 ⑤CI 图 ⑥行式打印机 ⑦总谱台），发牌指派位；经五张落选牌 raised 抬级后承担全表面。

FINISH：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## 未决

- 聊天三处保持本地 mock（接真 LLM 是产品级决定，不本次）
- 封存三页恢复时 el-tree 需换本地 FileTree（main.ts 全局注册已撤）
