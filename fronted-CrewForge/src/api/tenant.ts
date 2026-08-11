import request from './request'

/**
 * 团队接口（sys_tenant）
 * ownerId/当前成员数(members)后端自动维护，前端只传表单字段
 */

/** 团队（对应后端 TenantVO） */
export interface TenantVO {
  id: number
  name: string
  ownerId: number
  contact: string
  description: string
  status: number
  invitationCode: string
  /** 当前成员数（创建=1，审批通过+1） */
  members: number
  /** 容量上限（创建时设置，超出后审批时提醒） */
  maxMembers: number
  /** 团队项目数 */
  projectCount: number
  createTime: string
}

/** 创建团队（TenantDTO），返回新团队 id */
export function createTenant(dto: {
  name: string
  contact?: string
  description?: string
  /** 容量上限，不传默认 10 */
  maxMembers?: number
}): Promise<number> {
  return request.post('/api/tenant', { ...dto, status: 1 }) as Promise<number>
}

/** 查询单个团队（创建后拿邀请码用） */
export function fetchTenantById(id: number): Promise<TenantVO> {
  return request.get(`/api/tenant/${id}`) as Promise<TenantVO>
}

/** 编辑团队（仅管理员，ownerId 后端校验） */
export function updateTenant(
  id: number,
  dto: { name: string; contact?: string; description?: string; maxMembers?: number },
): Promise<void> {
  return request.put(`/api/tenant/${id}`, dto) as Promise<void>
}

/** 解散团队（仅管理员，逻辑删除） */
export function deleteTenant(id: number): Promise<void> {
  return request.delete(`/api/tenant/${id}`) as Promise<void>
}

/** 加入申请（对应后端 TenantApplyVO） */
export interface TenantApplyVO {
  id: number
  tenantId: number
  userId: number
  /** 申请人用户名（后端联查 sys_user） */
  username: string
  realName: string
  invitationCode: string
  /** 状态: 0-待审核, 1-已同意, 2-已拒绝 */
  status: number
  applyMsg: string
  createTime: string
}

/** 申请加入团队（凭邀请码，提交后等管理员审核） */
export function applyTenant(code: string): Promise<void> {
  return request.post(`/api/tenant/apply/${code}`) as Promise<void>
}

/** 团队成员（对应后端 MemberVO） */
export interface MemberVO {
  /** 用户 ID */
  id: number
  username: string
  realName: string
  /** 管理员 / 成员 */
  role: string
  createTime: string
}

/** 团队成员列表（仅团队成员可查看） */
export function fetchTeamMembers(tenantId: number): Promise<MemberVO[]> {
  return request.get('/api/tenant/members', { params: { tenantId } }) as Promise<MemberVO[]>
}

/** 申请列表（仅管理员） */
export function fetchApplyList(tenantId: number): Promise<TenantApplyVO[]> {
  return request.get('/api/tenant/apply/list', { params: { tenantId } }) as Promise<TenantApplyVO[]>
}

/** 同意申请（申请人正式成为成员） */
export function approveApply(id: number): Promise<void> {
  return request.put(`/api/tenant/apply/approve/${id}`) as Promise<void>
}

/** 拒绝申请 */
export function rejectApply(id: number): Promise<void> {
  return request.put(`/api/tenant/apply/reject/${id}`) as Promise<void>
}

/** 我的团队（后端默认只返回当前用户加入的团队，userId 从 JWT 取） */
export function fetchMyTeams(): Promise<PageResult<TenantVO>> {
  return request.get('/api/tenant', {
    params: { page: 1, pageSize: 100 },
  }) as Promise<PageResult<TenantVO>>
}

/** 分页响应（对应后端 PageResult<T>） */
export interface PageResult<T> {
  total: number
  records: T[]
}
