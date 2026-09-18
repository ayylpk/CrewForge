import request from './request'

/**
 * 项目运行 API（/api/project-run，阶段 2 开工按钮的接线）
 * 后端语义（ProjectRunServiceImpl）：
 *   start —— spawn bun 引擎（AUTO_CONFIRM/EXIT_AT_PHASE_BOUNDARY 注入），项目置 executing；
 *   按阶段起进程：引擎每阶段收口自退，Java 对账器 30s 一轮续拉，连续 5 次无进展熔断 failed；
 *   stop  —— 杀进程（含 Java 重启后的孤儿 pid），账目置 stopped（对账器不再自动拉），executing→paused。
 */

/** GET /api/project-run/{id} 返回（与 status() 的 HashMap 对齐，可空字段用 null） */
export interface RunStatus {
  running: boolean
  pid: number | null
  startedAt: string | null
  lastSpawnAt: string | null
  restartCount: number
  runState: string | null   // running / stopped
  exitCode: number | null
}

export function startProjectRun(projectId: number): Promise<void> {
  return request.post(`/api/project-run/${projectId}`) as Promise<void>
}

export function fetchRunStatus(projectId: number): Promise<RunStatus> {
  return request.get(`/api/project-run/${projectId}`) as Promise<RunStatus>
}

export function stopProjectRun(projectId: number): Promise<void> {
  return request.delete(`/api/project-run/${projectId}`) as Promise<void>
}
