/**
 * 项目文件树类型
 */
export interface FileNode {
  /** 数据库 id（有值 = 已落库 sys_project_file，点开可拉详情） */
  id?: number
  name: string
  type: 'dir' | 'file'
  path: string
  content?: string
  userModified?: boolean
  isNew?: boolean
  open?: boolean
  children?: FileNode[]
}

/** 后端项目文件（对应 sys_project_file / ProjectFileVO） */
export interface projectFileVO {
  id: number
  projectId: number
  filePath: string
  fileContent?: string
  fileType: string
  userModified: number
  createTime: string
  updateTime: string
}
