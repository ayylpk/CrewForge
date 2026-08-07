/**
 * 项目文件树类型
 */
export interface FileNode {
  name: string
  type: 'dir' | 'file'
  path: string
  content?: string
  userModified?: boolean
  isNew?: boolean
  open?: boolean
  children?: FileNode[]
}

/** 按路径查找节点 */
export function findNode(nodes: FileNode[], path: string): FileNode | null {
  for (const n of nodes) {
    if (n.path === path) return n
    if (n.children) {
      const found = findNode(n.children, path)
      if (found) return found
    }
  }
  return null
}
