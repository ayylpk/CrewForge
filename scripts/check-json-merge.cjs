/* 用真实库数据的形状验证 utils/json.ts 的合并函数不毁数据。
   跑法（两步，前端没有测试框架，而这两个函数写错就是静默毁数据）：
     node fronted-CrewForge/node_modules/typescript/bin/tsc fronted-CrewForge/src/utils/json.ts \
          --module commonjs --target es2022 --outDir .tmp-jsoncheck
     node scripts/check-json-merge.cjs
   数据取自现网 sys_project 的真实值（项目 20 的引擎信封 / 项目 4 的网页裸数组）。 */
const path = require('path')
const compiled = path.join(__dirname, '..', '.tmp-jsoncheck', 'json.js')
let jsonUtil
try {
  jsonUtil = require(compiled)
} catch {
  console.error('找不到编译产物，请先跑这一步（前端无测试框架，故用 tsc 把纯模块编译出来）：')
  console.error('  node fronted-CrewForge/node_modules/typescript/bin/tsc \\')
  console.error('    fronted-CrewForge/src/utils/json.ts --module commonjs --target es2022 --outDir .tmp-jsoncheck')
  process.exit(2)
}
const {
  buildDevPlanJson,
  buildTechStackJson,
  parseEnvelopeArray,
  toDisplayList,
  ENVELOPE_KEYS,
} = jsonUtil

let failed = 0
const ok = (cond, label) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}`)
  if (!cond) failed++
}

/* ========== 用例 1：引擎富信封（项目 20 的 dev_plan 真形状）========== */
const env = {
  risks: ['统一身份校验需覆盖所有业务接口'],
  phases: [
    {
      goal: '建立全局统一身份校验和用户管理能力',
      name: '身份与用户基础',
      risk: '高',
      phase: 1,
      uiStyle: '无前端，仅后端/API',
      features: ['用户管理', '统一身份校验'],
      dependencies: [],
      relative_effort: '中',
    },
    { goal: 'g2', name: '内容发布', risk: '中', phase: 2, features: ['发帖'], dependencies: [1], relative_effort: '中' },
  ],
  project: { name: 'x' },
  features: ['用户管理'],
  mvp_scope: ['a'],
  uiProfile: { style: '清爽' },
}
const originals = env.phases
// 页面模型：改名 + 改任务（模拟用户在绘图桌上的操作）
const edited = [
  { name: '身份与用户基础（改名）', progress: 0, tasks: ['用户管理'] },
  { name: '内容发布', progress: 0, tasks: ['发帖', '评论'] },
]
const outEngine = JSON.parse(buildDevPlanJson(env, originals, edited, true))

console.log('用例1 引擎富信封 + 页面改名/改任务：')
ok(outEngine.risks !== undefined, '信封 risks 保留')
ok(outEngine.project !== undefined, '信封 project 保留')
ok(outEngine.features !== undefined, '信封顶层 features 保留')
ok(outEngine.mvp_scope !== undefined, '信封 mvp_scope 保留')
ok(outEngine.uiProfile !== undefined, '信封 uiProfile 保留')
const p0 = outEngine.phases[0]
ok(p0.phase === 1, `阶段数字 phase 保留（usablePhases 硬要求）→ ${p0.phase}`)
ok(p0.goal === '建立全局统一身份校验和用户管理能力', '阶段 goal 保留')
ok(p0.risk === '高' && p0.uiStyle === '无前端，仅后端/API', '阶段 risk / uiStyle 保留')
ok(p0.dependencies !== undefined && p0.relative_effort === '中', '阶段 dependencies / relative_effort 保留')
ok(p0.name === '身份与用户基础（改名）', '阶段名被页面改名覆盖')
ok(Array.isArray(p0.features) && p0.features.length === 1, '任务清单写回**原键 features**')
ok(!('tasks' in p0), '没有往引擎形状里塞多余的 tasks 键')
ok(outEngine.phases[1].features.length === 2, '第二个阶段的任务也写回 features')

/* ========== 用例 2：新增阶段必须补数字 phase ========== */
const withNew = JSON.parse(
  buildDevPlanJson(env, originals, [...edited, { name: '新增阶段', progress: 0, tasks: ['x'] }], true),
)
const p2 = withNew.phases[2]
console.log('用例2 新增阶段：')
ok(p2.phase === 3, `新增阶段补了数字 phase=3（否则引擎 usablePhases 不认）→ ${p2.phase}`)
ok(p2.name === '新增阶段' && Array.isArray(p2.features), '新增阶段有 name + features')

/* ========== 用例 3：网页裸数组形状（项目 4 的 dev_plan 真形状）========== */
const webPlan = [{ name: '基础认证与权限框架', tasks: ['常规登录与登出', '会话保持与过期'], progress: 0 }]
const outWeb = JSON.parse(
  buildDevPlanJson(null, webPlan, [{ name: '基础认证与权限框架', progress: 0, tasks: ['常规登录与登出'] }], false),
)
console.log('用例3 网页裸数组形状：')
ok(Array.isArray(outWeb), '仍是裸数组（不无端套信封）')
ok(outWeb[0].tasks.length === 1 && outWeb[0].name === '基础认证与权限框架', '写回原键 tasks')

/* ========== 用例 4：tech_stack 信封保住分类对象 ========== */
const engineStack = {
  why: '延续阶段1选型',
  tables: ['sys_user'],
  moduleTech: [],
  techniques: { database: { why: '关系型', type: 'PostgreSQL' }, middleware: [{ name: 'JWT认证中间件', purpose: 'p' }] },
}
const outStack = JSON.parse(buildTechStackJson(engineStack, ['Vue 3', 'PostgreSQL']))
console.log('用例4 tech_stack 信封：')
ok(outStack.why === '延续阶段1选型', '信封 why 保留')
ok(typeof outStack.techniques === 'object' && outStack.techniques !== null, 'techniques 分类对象**未被扁平数组顶替**')
ok(Array.isArray(outStack.technologies) && outStack.technologies.length === 2, '用户编辑的清单写进独立键 technologies')
ok(Array.isArray(outStack.tables), '信封 tables 保留')

/* ========== 用例 5：读取方向（页面上要能显示引擎数据）========== */
console.log('用例5 读取：')
const mods = toDisplayList(
  parseEnvelopeArray(
    JSON.stringify({ risks: [], modules: [{ name: '待办接口模块', points: [] }], summary: '', deliverables: [] }),
    ENVELOPE_KEYS.businessModules,
  ),
)
ok(mods.length === 1 && mods[0] === '待办接口模块', `business_modules 信封取到模块名 → ${JSON.stringify(mods)}（不是 [object Object]）`)
const webStack = toDisplayList(parseEnvelopeArray(JSON.stringify(['Vue 3', 'MySQL']), ENVELOPE_KEYS.techStack))
ok(webStack.length === 2, '网页裸数组仍正常读取')
const afterEdit = toDisplayList(parseEnvelopeArray(JSON.stringify(outStack), ENVELOPE_KEYS.techStack))
ok(afterEdit.length === 2, `保存后再读回，优先取用户清单 technologies → ${JSON.stringify(afterEdit)}`)

console.log(failed === 0 ? '\n全部通过：合并/读取都不毁数据' : `\n有 ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
