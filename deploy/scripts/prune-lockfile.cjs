#!/usr/bin/env node
/*
 * prune-lockfile.cjs —— 从 package-lock.json 里摘掉"没人再依赖"的包
 * ---------------------------------------------------------------------------
 * 为什么需要它：这台机器**没有外网**（registry.npmmirror.com 连不上），
 * `npm install --package-lock-only` 和 `npm prune` 都会以 ENOTCACHED 失败，
 * 于是删掉 package.json 里的一行依赖之后，lock 里会留下一堆孤儿条目
 * （element-plus 连同它 13 个只服务它的传递依赖）。
 *
 * 做法：从 packages[""] 的 dependencies/devDependencies 出发做可达性遍历，
 * 按 Node 的 node_modules 逐级上溯规则解析每个依赖名，凡是走不到的条目全删。
 * 只动 `packages` 映射，不碰 version/integrity（那是 npm 自己写的）。
 *
 * 用法：
 *   node scripts/prune-lockfile.cjs <lockfile>           # 干跑，只打印
 *   node scripts/prune-lockfile.cjs <lockfile> --apply   # 真删
 */
const fs = require('node:fs')
const path = require('node:path')

const file = process.argv[2]
const apply = process.argv.includes('--apply')
if (!file) {
  console.error('用法: node scripts/prune-lockfile.cjs <package-lock.json> [--apply]')
  process.exit(2)
}

const lock = JSON.parse(fs.readFileSync(file, 'utf8'))
if (lock.lockfileVersion !== 3 || !lock.packages) {
  console.error(`只支持 lockfileVersion 3 + packages 映射，当前为 ${lock.lockfileVersion}`)
  process.exit(2)
}
const packages = lock.packages
const dir = path.dirname(path.resolve(file))

/* 先把 packages[""] 的依赖清单对齐 package.json —— 否则"根依赖已从 package.json 删掉、
   lock 里还留着"这一步会让 element-plus 依然可达，孤儿数永远是 0。 */
const rootPkgPath = path.join(dir, 'package.json')
if (fs.existsSync(rootPkgPath)) {
  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'))
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const want = rootPkg[field]
    if (want) packages[''][field] = want
    else delete packages[''][field]
  }
  const drift = []
  const lockNames = new Set(Object.keys(lock.packages).filter((p) => /^node_modules\/[^/]+$|^node_modules\/@[^/]+\/[^/]+$/.test(p)))
  for (const field of ['dependencies', 'devDependencies']) {
    for (const name of Object.keys(rootPkg[field] || {})) {
      if (!lockNames.has('node_modules/' + name)) drift.push(`${name} (在 package.json，不在 lock)`)
    }
  }
  console.log(`已按 package.json 同步根依赖清单`)
  if (drift.length) console.log(`⚠️ 下面这些包 lock 里没有，得联网 \`npm install\` 才能补：\n  ${drift.join('\n  ')}`)
  console.log('')
}

/** from 目录本身 + 它的各级祖先（含 '' 代表根 node_modules） */
function ancestorsOf(from) {
  const out = [from]
  let cur = from
  while (cur) {
    const i = cur.lastIndexOf('/')
    cur = i === -1 ? '' : cur.slice(0, i)
    out.push(cur)
  }
  return out
}

/** 按 Node 的解析顺序，把 name 从 from 目录解析到一个 lock 里的路径 */
function resolveFrom(from, name) {
  for (const anc of ancestorsOf(from)) {
    const cand = (anc ? anc + '/' : '') + 'node_modules/' + name
    if (packages[cand]) return cand
  }
  return null
}

const DEP_FIELDS = ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies']
const seen = new Set()
const missing = []
const queue = ['']

while (queue.length) {
  const from = queue.shift()
  if (seen.has(from)) continue
  seen.add(from)
  const pkg = packages[from]
  if (!pkg) continue
  for (const field of DEP_FIELDS) {
    const deps = pkg[field]
    if (!deps || typeof deps !== 'object') continue
    for (const name of Object.keys(deps)) {
      const to = resolveFrom(from, name)
      if (!to) {
        // lock 里没有（可选 peer / 平台包）——不算错，记一笔备查
        if (field !== 'optionalDependencies') missing.push(`${from || '<root>'} -> ${name} (${field})`)
        continue
      }
      if (!seen.has(to)) queue.push(to)
    }
  }
}

const all = Object.keys(packages)
const dead = all.filter((p) => p && !seen.has(p))
const deadSet = new Set(dead)

/** 每个被删包的体积，用来讲清到底省了多少 */
function sizeOf(p) {
  const dir = path.join(path.dirname(file), p)
  if (!fs.existsSync(dir)) return 0
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile()) total += fs.statSync(full).size
    }
  }
  return total
}

let freed = 0
console.log(`lock 共 ${all.length} 个条目，可达 ${seen.size - 1} 个，孤儿 ${dead.length} 个：\n`)
for (const p of dead) {
  const bytes = sizeOf(p)
  freed += bytes
  console.log(`  - ${p}  (${(bytes / 1024).toFixed(0)} KB)`)
}
// 被删掉的包还留在别人的 dependencies 里吗？（说明根依赖没清干净）
const staleRefs = []
for (const [p, pkg] of Object.entries(packages)) {
  if (deadSet.has(p)) continue
  for (const field of DEP_FIELDS) {
    for (const name of Object.keys(pkg[field] || {})) {
      const to = resolveFrom(p, name)
      if (to && deadSet.has(to)) staleRefs.push(`${p || '<root>'} 的 ${field} 仍指向 ${to}`)
    }
  }
}
console.log(`\n合计可省 ${(freed / 1024 / 1024).toFixed(2)} MB`)
if (missing.length) console.log(`\nlock 里查无此包（可选 peer / 平台包，正常）：\n  ${missing.join('\n  ')}`)
if (staleRefs.length) {
  console.log(`\n⚠️ 有活包仍指向被删包，说明根依赖没删干净：\n  ${staleRefs.join('\n  ')}`)
  process.exit(1)
}

if (!apply) {
  console.log('\n（干跑，未改动。加 --apply 才真删）')
  process.exit(0)
}
if (!dead.length) {
  console.log('\n没有孤儿，无需改动。')
  process.exit(0)
}
for (const p of dead) delete packages[p]
if (typeof lock.requires === 'boolean') lock.requires = true
fs.writeFileSync(file, JSON.stringify(lock, null, 2) + '\n')
console.log(`\n已写入 ${file}：${all.length} → ${Object.keys(packages).length} 条`)
