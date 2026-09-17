/* ============================================================
   目录树公共类型 + 工具（架构师的 SheetTree 用）
   ------------------------------------------------------------
   内存态 TreeNode 带 id/open（UI 用）；落库 dirTree 只存
   {name,type,children} 干净结构。id 由全局自增序列发（restore 时播种）。
   ============================================================ */

export interface TreeNode {
  id: number
  name: string
  type: 'dir' | 'file'
  open?: boolean
  children?: TreeNode[]
}

/** 落库用的干净节点 */
export interface CleanNode {
  name: string
  type: 'dir' | 'file'
  children?: CleanNode[]
}

let seq = 0

/** restoreTree 后调用：把序列播到已用最大 id 之后，避免撞号 */
export function seedSeq(max: number) {
  if (max > seq) seq = max
}

export function currentSeq() {
  return seq
}

export function newNode(name: string, type: 'dir' | 'file'): TreeNode {
  const n: TreeNode = { id: ++seq, name, type }
  if (type === 'dir') {
    n.open = true
    n.children = []
  }
  return n
}

/** 深拷贝并重发新 id（粘贴复制件/防引用别名） */
export function cloneFresh(node: TreeNode): TreeNode {
  const n = newNode(node.name, node.type)
  n.open = node.open
  if (node.type === 'dir') n.children = (node.children || []).map(cloneFresh)
  return n
}

/** 遍历找最大 id */
export function maxId(nodes: TreeNode[]): number {
  let m = 0
  const walk = (arr: TreeNode[]) => {
    for (const n of arr) {
      if (n.id > m) m = n.id
      if (n.children) walk(n.children)
    }
  }
  walk(nodes)
  return m
}

/** 干净结构 → 内存态（dirTree JSON.parse 之后 restore；open 默认展开目录） */
export function restoreTree(nodes: CleanNode[] | null | undefined): TreeNode[] {
  const out: TreeNode[] = []
  seedSeq(maxId(out))
  for (const n of nodes || []) {
    const t = newNode(String(n.name || '未命名'), n.type === 'dir' ? 'dir' : 'file')
    if (t.type === 'dir') {
      t.open = true
      t.children = restoreTree(n.children)
    }
    out.push(t)
  }
  return out
}

/** 内存态 → 干净结构（去 id/open，JSON.stringify 前调用） */
export function cleanTree(nodes: TreeNode[]): CleanNode[] {
  return nodes.map((n) => {
    const c: CleanNode = { name: n.name, type: n.type }
    if (n.type === 'dir') c.children = cleanTree(n.children || [])
    return c
  })
}

/** 深度优先找节点 */
export function findNodeById(nodes: TreeNode[], id: number): TreeNode | null {
  for (const n of nodes) {
    if (n.id === id) return n
    if (n.children) {
      const hit = findNodeById(n.children, id)
      if (hit) return hit
    }
  }
  return null
}

/** target 在 subtree 内吗（含自身）——粘贴环防护用 */
export function containsNode(subtree: TreeNode, targetId: number): boolean {
  if (subtree.id === targetId) return true
  return (subtree.children || []).some((c) => containsNode(c, targetId))
}
