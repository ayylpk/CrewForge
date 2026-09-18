/* ============================================================
   JSON 列读取（双形状宽容）
   ------------------------------------------------------------
   项目表这几列在库里是**双形状**的 —— 网页写裸数组，引擎写信封对象：

     businessModules:  ["功能A"]                |  {risks, modules:[{name,points,…}], summary, deliverables}
     techStack:        ["Vue 3"]                |  {why, tables, moduleTech, techniques}
     devPlan:          [{name,progress,tasks}]  |  {risks, phases:[…], project, features, mvp_scope, uiProfile}
     dirTree:          [{name,type,children}]   |  （目前只有数组）

   9/17 实测现网 22 行：dev_plan 19 个对象、tech_stack 12 个、business_modules 13 个。
   旧实现一律写成 "不是数组就返回 []"，于是这些行在页面上**全显示为空**
   （"还没有确认功能"/"暂无技术选型"），而数据其实都在。
   信封的 key 名是引擎侧定的，所以这里按字段显式列出，不做魔法猜测。
   ============================================================ */
/** 信封里各字段的数组所在 key（顺序即优先级） */
export const ENVELOPE_KEYS = {
    businessModules: ['modules', 'features', 'deliverables'],
    // PM 澄清产物：manager 写的形状就是 {features:[{name,description,priority,acceptance}]}。
    // ⚠️ 与 businessModules 是**两个阶段的两种产物**，别混用（9/18 踩过）：
    //   clarified_req    = PM 澄清阶段每轮累积的"已确认功能"（manager 写）
    //   business_modules = 架构师拆分出来的业务模块（架构师写）
    // 需求对话页该读前者；概览页优先后者（那是最终交付物）。
    clarifiedReq: ['features'],
    // 架构师页"技术选型"标签云：**只取网页自己写的扁平清单**。
    // ⚠️ 9/18 修：原来这里是 ['technologies','techniques','moduleTech','middleware','tables']，
    //    找不到 technologies 就一路退到 moduleTech/tables —— 那两个是**对象数组**
    //    （{module,backend,frontend} / {name,fields,purpose}），toDisplayList 认不出
    //    就 JSON.stringify，页面上把一坨原始 JSON 当标签印出来。
    //    现网 10 个项目全部命中（引擎信封里没有 technologies 这个键）。
    //    结构化数组现在交给 ArchitectView 的「架构师方案」只读面板渲染，不进标签云。
    techStackPageList: ['technologies'],
    techStack: ['technologies', 'techniques', 'moduleTech', 'middleware', 'tables'],
    devPlan: ['phases'],
    dirTree: ['tree', 'children'],
};
/**
 * 从"裸数组或信封对象"里取出数组。
 * 传了 envelopeKeys 就按它找；找不到时退一步取对象里**第一个数组值**
 * （引擎信封加键是常态，硬编码一个 key 迟早漂移）。
 */
export function parseEnvelopeArray(raw, envelopeKeys = []) {
    if (!raw)
        return [];
    let v;
    try {
        v = JSON.parse(raw);
    }
    catch {
        return []; // 坏 JSON 一律当"没有"，不炸页面
    }
    if (Array.isArray(v))
        return v;
    if (v && typeof v === 'object') {
        const obj = v;
        for (const k of envelopeKeys) {
            if (Array.isArray(obj[k]))
                return obj[k];
        }
        for (const inner of Object.values(obj)) {
            if (Array.isArray(inner))
                return inner;
        }
    }
    return [];
}
/**
 * 数组 → 字符串数组（用于清单类展示）。
 * 信封外的数组元素可能是字符串，也可能是对象（如 businessModules 的 {name, points}）。
 * ⚠️ 不能直接 .map(String)：对象会变成 "[object Object]" 印到页面上。
 * 对象优先取 name/title/label，都没有才 JSON 序列化兜底。
 */
export function toDisplayList(items) {
    return items
        .map((it) => {
        if (it == null)
            return '';
        if (typeof it === 'string')
            return it;
        if (typeof it === 'number' || typeof it === 'boolean')
            return String(it);
        if (typeof it === 'object') {
            const o = it;
            for (const k of ['name', 'title', 'label', 'summary']) {
                const v = o[k];
                if (typeof v === 'string' && v)
                    return v;
            }
            try {
                return JSON.stringify(it);
            }
            catch {
                return '';
            }
        }
        return String(it);
    })
        .map((s) => s.trim())
        .filter(Boolean);
}
/** 阶段对象里"任务清单"所在的键：引擎写 features，网页写 tasks —— 谁原来有就写回谁 */
export function taskKeyOf(phase) {
    if (Array.isArray(phase.tasks))
        return 'tasks';
    if (Array.isArray(phase.features))
        return 'features';
    return 'tasks';
}
/**
 * 用页面编辑结果生成新的 devPlan JSON：逐条**在原阶段对象上合并**
 * （只覆盖 name 与任务清单），信封其余键原样带回。
 *
 * 为什么不能"用页面模型重建"：库里 dev_plan 是引擎写的富信封
 *   {risks, phases:[{goal,name,risk,phase,uiStyle,features,dependencies,relative_effort}],
 *    project, features, mvp_scope, uiProfile}
 * 页面模型只有 {name, progress, tasks}。整体重建会丢掉信封全部其他键，
 * **连每个阶段的数字 `phase` 一起丢** —— 而引擎的 usablePhases() 硬要求
 * `Number.isInteger(Number(p.phase))`，丢了它引擎读回 dev_plan 会判定计划不可用，
 * 退回去重跑 PM 对话（引擎侧真故障，不只是少显示几个字段）。
 *
 * 新增阶段按原形状补齐必填键：引擎形状补数字 phase，否则 usablePhases 不认。
 */
export function buildDevPlanJson(envelope, originalPhases, edited, engineShape) {
    const merged = edited.map((p, i) => {
        const orig = originalPhases[i];
        if (orig && typeof orig === 'object') {
            return { ...orig, name: p.name, [taskKeyOf(orig)]: p.tasks };
        }
        return engineShape
            ? { phase: i + 1, name: p.name, features: p.tasks }
            : { name: p.name, progress: 0, tasks: p.tasks };
    });
    return JSON.stringify(envelope ? { ...envelope, phases: merged } : merged);
}
/**
 * 生成新的 techStack JSON。
 * 引擎信封里的 techniques 是**分类对象**（{database:{…}, middleware:[{name,purpose}]}），
 * 与本页的扁平字符串数组不是同一个数据模型，硬塞进去就是损坏。
 * 所以：有信封就保留原样，把用户编辑的扁平清单写进独立的 `technologies` 键
 * （读取时优先取 technologies，见 ENVELOPE_KEYS.techStack 的顺序）。
 */
export function buildTechStackJson(envelope, list) {
    if (envelope)
        return JSON.stringify({ ...envelope, technologies: list });
    return JSON.stringify(list);
}
/**
 * 只保留**字符串**的清单（给"标签/chip"这类扁平展示用）。
 *
 * 为什么需要它（9/18 架构师页实测）：引擎的 tech_stack 信封里
 * `moduleTech: [{module, backend, frontend}]`、`tables: [{name, fields, purpose}]`
 * 都是**对象数组**，而 toDisplayList() 认不出这些键 → 兜底 JSON.stringify
 * → 页面上把 `{"module":"用户登录与退出","backend":"…","frontend":"…"}` 原样印出来。
 * 现网 10 个项目**全部**是这种信封，等于技术选型那块一直在印原始 JSON。
 *
 * 所以：chips 只吃真字符串；结构化数组交给专门的只读面板渲染（见 ArchitectView）。
 */
export function toStringList(items) {
    return items
        .filter((it) => typeof it === 'string')
        .map((s) => s.trim())
        .filter(Boolean);
}
const asStr = (v) => (typeof v === 'string' ? v : '');
/** 只认"是对象"的数组元素：null/字符串混进来会让模板里的字段访问崩 */
function objArray(v) {
    return Array.isArray(v) ? v.filter((x) => x != null && typeof x === 'object') : [];
}
export function parseArchPlan(envelope) {
    const e = envelope ?? {};
    const why = asStr(e.why);
    const moduleTech = objArray(e.moduleTech).map((m) => ({
        module: asStr(m.module),
        backend: asStr(m.backend),
        frontend: asStr(m.frontend),
    }));
    const tables = objArray(e.tables).map((t) => ({
        name: asStr(t.name),
        purpose: asStr(t.purpose),
        fields: objArray(t.fields).map((f) => ({
            name: asStr(f.name),
            type: asStr(f.type),
            remark: asStr(f.remark),
            required: f.required === true,
        })),
    }));
    const tech = e.techniques && typeof e.techniques === 'object' ? e.techniques : {};
    const db = tech.database && typeof tech.database === 'object' ? tech.database : null;
    const dbType = db ? { type: asStr(db.type), why: asStr(db.why) } : null;
    const middleware = objArray(tech.middleware).map((m) => ({
        name: asStr(m.name),
        purpose: asStr(m.purpose),
    }));
    return {
        why,
        moduleTech,
        tables,
        dbType,
        middleware,
        has: Boolean(why || moduleTech.length || tables.length || middleware.length || dbType),
    };
}
/**
 * 生成新的 clarifiedReq JSON（需求对话页「保存功能清单」用）。
 *
 * 为什么必须**保结构合并**而不是 `{features: list}` 一把重建：
 *   页面上的清单是 toDisplayList() 压出来的字符串数组（只有 name），
 *   而库里每条是 {name, description, priority, acceptance} —— PM 一字一句写出来的。
 *   直接重建 = 把 description/priority/acceptance 全冲掉，而且是**静默**的：
 *   页面上名字还在，看不出内容已经没了。9/18 实测抓到（写 65 字 vs 原文 840 字）。
 *
 * 合并口径：按 name 对上就保留原对象、只覆盖 name；对不上的（新增/改过名）当新功能写 {name}。
 * 改名与"删掉再加一条"在这一层无从区分，所以牺牲改名者的细节——比静默毁数据好。
 */
export function buildClarifiedReqJson(envelope, list) {
    const orig = Array.isArray(envelope?.features) ? envelope.features : [];
    const byName = new Map();
    for (const it of orig) {
        if (it && typeof it === 'object') {
            const o = it;
            if (typeof o.name === 'string' && o.name)
                byName.set(o.name, o);
        }
    }
    const features = list.map((name) => {
        const hit = byName.get(name);
        return hit ? { ...hit, name } : { name };
    });
    return JSON.stringify(envelope ? { ...envelope, features } : { features });
}
