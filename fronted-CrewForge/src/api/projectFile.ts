import request from './request'
import type { projectFileVO } from '../types/file'

/**
 * 项目文件接口（sys_project_file）
 * 列表不含内容（拼文件树用），详情含完整内容（点开文件时拉取）
 */

/** 项目文件列表（不分页，一次返回全部，不含 fileContent） */
export function fetchProjectFiles(projectId: number): Promise<projectFileVO[]> {
  return request.get('/api/projectfile/list', { params: { projectId } }) as Promise<projectFileVO[]>
}

/** 单个文件详情（含完整内容） */
export function fetchProjectFileDetail(id: number): Promise<projectFileVO> {
  return request.get(`/api/projectfile/${id}`) as Promise<projectFileVO>
}
