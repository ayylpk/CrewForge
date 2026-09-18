import request from './request'

/**
 * 项目验收与证据 API（后端 /api/project-verify/{id}，只读）
 *
 * 数据来自两处：
 *   库 —— sys_project_run（进程账本）+ sys_task（任务级实测证据）
 *   产物树 —— {runsRoot}/p{id}/_verify/（交付关报告、验收判据、终态判据）+ logs/p{id}.run.log
 * 产物树可能整棵不存在（没跑过/被清理）→ 后端不报错，只在 notes 里说明缺什么。
 */

/** 一条验收判据：后端已把三种 kind 摊平成同一结构，用不到的字段是 null */
export interface AcceptanceCase {
  /** 来自哪个阶段文件，如 acceptance-p1.json */
  from: string
  id: string | null
  /** http | command | testFile */
  kind: string | null
  /** 给人看的说明（不参与判定） */
  display: string | null
  method?: string | null
  path?: string | null
  expectStatus?: number | null
  hasBody?: boolean
  command?: string | null
  expectExitCode?: number | null
  testPath?: string | null
}

/** 任务级证据（sys_task 一行） */
export interface TaskEvidence {
  id: number
  taskIdExt: string | null
  title: string
  status: string
  layer: string | null
  assignee: string | null
  retryCount: number
  result: string | null
  errorMsg: string | null
}

/** 进程账本（sys_project_run 一行） */
export interface RunBook {
  pid: number | null
  runState: string | null
  startedAt: string | null
  lastSpawnAt: string | null
  restartCount: number | null
  exitCode: number | null
}

/** 终态判据（_verify/completion.json；只在非 done 或带失败详情时落盘） */
export interface CompletionDoc {
  schemaVersion?: string
  status?: string
  decidedAt?: string
  reasons?: string[]
  failureDetail?: { kind?: string; message?: string; attempts?: number } | null
  taskBreakdown?: { total?: number; done?: number; failed?: number; todo?: number; doing?: number }
}

export interface VerifyEvidence {
  projectId: number
  /** "缺了什么、为什么缺"的说明；空数组 = 该有的证据都齐 */
  notes: string[]
  run: RunBook
  taskEvidence: TaskEvidence[]
  acceptance: { files: string[]; cases: AcceptanceCase[] }
  /** _verify/run-report.md 全文（null = 没跑执行式验证） */
  runReport: string | null
  completion: CompletionDoc | null
  /** logs/p{id}.run.log 末尾若干行 */
  logTail: string[]
}

export function fetchVerifyEvidence(projectId: number): Promise<VerifyEvidence> {
  return request.get(`/api/project-verify/${projectId}`) as Promise<VerifyEvidence>
}
