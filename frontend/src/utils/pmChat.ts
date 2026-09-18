/* ============================================================
   执行面板对话的回答器（纯函数）
   ------------------------------------------------------------
   为什么抽出来：这是个"会说话的看板"，一旦说错（比如明明有失败任务却说没有）
   就是在骗人。抽成不依赖 Vue 的纯函数，才能拿**真实 sys_task 行**跑它
   —— 前端没有测试框架，这跟 utils/json.ts 里那几个 build* 是同一个理由。

   数据来源全部是执行面板本来就在轮询的真数据，没有一处是预置文案：
     tasks           sys_task（状态 / 失败原因 / 返工次数 / 层）
     currentPhase    收口进度算出来的阶段
     pending         sys_confirm 里挂着的待答题（确认门）
     fileCount       产物树文件数
     topDirs         产物树前两层目录名

   答不了的就明说答不了。"这段代码为什么这么写"要读代码，现在没有那条链
   （没有 LLM 通道），与其编一句听起来合理的话，不如把人指到真凭据。
   ============================================================ */

export interface PmTask {
  id: number
  taskIdExt: string | null
  title: string
  status: 'todo' | 'doing' | 'done' | 'failed'
  retryCount: number
  layer: string | null
  errorMsg: string | null
}

export interface PmPending {
  question: string
  expireAt: string | null
  /** 超时放行倒计时的中文说明（由调用方用页面现成的 confirmCountdown 给） */
  countdown?: string
}

export interface PmSnapshot {
  tasks: PmTask[]
  currentPhase: string
  overallProgress: number
  pending: PmPending[]
  fileCount: number
  topDirs: string[]
}

/** 超长文本截断（错误原因经常是一整段编译报错） */
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)

export function pmAnswer(s: PmSnapshot, text: string): string {
  const total = s.tasks.length
  const doneN = s.tasks.filter((t) => t.status === 'done').length
  const doing = s.tasks.filter((t) => t.status === 'doing')
  const failed = s.tasks.filter((t) => t.status === 'failed')
  const todoN = s.tasks.filter((t) => t.status === 'todo').length

  // —— 进度 / 阶段 ——
  if (/进度|到哪|多久|完成了|阶段/.test(text)) {
    if (!total) return '还没有任务落到看板上——引擎可能还没跑，或还没派单。可以看右下「执行日志」确认引擎起没起。'
    const lines = [
      `当前阶段：${s.currentPhase || '（未识别，引擎还没报阶段边界）'}，整体 ${s.overallProgress}%。`,
      `任务：${doneN}/${total} 已完成，${doing.length} 个在跑，${todoN} 个待办，${failed.length} 个失败。`,
    ]
    if (failed.length) {
      lines.push(`\n卡住的是这 ${failed.length} 个：`)
      for (const t of failed.slice(0, 5)) {
        lines.push(`· ${t.taskIdExt || t.id}「${t.title}」：${cut((t.errorMsg || '未记录原因').split('\n')[0] ?? '', 80)}`)
      }
      if (failed.length > 5) lines.push(`（还有 ${failed.length - 5} 个，去任务看板的「失败」列看全）`)
    }
    return lines.join('\n')
  }

  // —— 卡住 / 失败原因 ——
  if (/卡|失败|报错|错了|为什么没过|不通过/.test(text)) {
    if (!failed.length) {
      return total
        ? `现在没有失败任务（${doneN}/${total} 已完成）。之前失败过的会在看板上带返工次数，重跑记录也留在「执行日志」里。`
        : '还没有任务数据，看不出卡在哪。'
    }
    const lines = [`有 ${failed.length} 个失败任务：`]
    for (const t of failed) {
      lines.push(`\n· ${t.taskIdExt || t.id}「${t.title}」`)
      // retry_count=0 是常态（首次就失败），说"第 0 次返工"读着像假话 —— 有返工才提
      lines.push(t.retryCount > 0 ? `  已返工 ${t.retryCount} 次 · 层=${t.layer || '未知'}` : `  层=${t.layer || '未知'}`)
      lines.push(`  原因：${cut(t.errorMsg || '未记录原因', 400)}`)
    }
    lines.push('\n要我重跑某一个，去任务看板点它的「重跑」；引擎在阶段边界消费返工。')
    return lines.join('\n')
  }

  // —— 待答 / 要我确认 ——
  if (/要我|确认什么|待答|等我|什么问题|卡在等你/.test(text)) {
    if (!s.pending.length) return '当前没有等你拍板的问题（确认门是空的）。'
    const q = s.pending[0]!
    return `有 ${s.pending.length} 道题在等你，最新一道：\n\n${q.question}\n\n（页面上会弹出问答卡，答完引擎几秒内续跑${q.countdown ? `；${q.countdown}` : ''}）`
  }

  // —— 产出 / 文件 ——
  if (/文件|产出|写了什么|代码在哪/.test(text)) {
    if (!s.fileCount) return '还没有产物落到项目树里（引擎还没写文件，或还没到写代码的阶段）。'
    const dirs = s.topDirs.length ? `\n顶层结构：\n${s.topDirs.map((d) => `  ${d}/`).join('\n')}` : ''
    return `项目树里现在有 ${s.fileCount} 个文件。${dirs}\n\n（点左侧图夹脊切到「项目文件」能逐个打开看；生成规则与验收判据在「验收与证据」页。）`
  }

  // —— 停 / 继续 ——
  if (/暂停|停一下|继续|恢复|中止/.test(text)) {
    return '引擎按阶段自动推进，没有"暂停"这种中间态——停就是停运行：回项目详情页点「停止运行」，再点「开工」会从阶段边界续跑（进度存在 checkpoint 里，不会从头来）。'
  }

  // —— 下一步 ——
  if (/下一步|接下来|后面|还差什么/.test(text)) {
    if (failed.length) return `先把这 ${failed.length} 个失败任务处理掉（看板点重跑），否则当前阶段过不了收口门。`
    if (s.pending.length) return '先答掉确认门里那道题，引擎在等它才能续跑。'
    if (doing.length) {
      const ids = doing.slice(0, 3).map((t) => t.taskIdExt || t.id).join('、')
      return `${doing.length} 个任务在跑：${ids}${doing.length > 3 ? ' 等' : ''}。跑完这批当前阶段就收口。`
    }
    if (total && doneN < total) return `还有 ${todoN} 个待办没派下去，等引擎下一轮调度。`
    if (total && doneN === total) return '当前阶段的任务全完了，引擎会做阶段收口（编译门 + 契约探针），过了就进下一阶段。'
    return '还没有任务数据，先确认引擎在跑（右下「执行日志」有没有在出字）。'
  }

  // —— 代码为什么这么写：答不了，但说清楚为什么答不了 ——
  if (/为什么.*(写|这么|这样)|怎么实现|代码.*(逻辑|原理)|看看代码/.test(text)) {
    return '这个我答不了 —— 执行面板的对话没有接 LLM，只能读库里的**状态类**数据（任务、失败原因、确认门、产物树、日志）。\n「这段代码为什么这么写」要读代码本身才知道，现在没有这条链。\n能给你的是真凭据：右下「执行日志」有每次失败/重跑的原话，任务详情弹窗里有该任务的验收判据和 errorMsg，产物在左侧「项目文件」。'
  }

  // —— 兜底：不编话，说清楚能答什么 ——
  const realtime = total ? `${doneN}/${total} 任务完成，${failed.length} 个失败，${doing.length} 个在跑` : '还没有任务数据'
  return `这个问题我答不了（执行面板的对话只读状态数据，没接 LLM）。\n现在能答的：进度、卡住/失败原因、要我确认什么、产出文件、下一步、怎么停。\n换个问法试试，或看右下「执行日志」。\n\n当前实况：${realtime}。`
}
