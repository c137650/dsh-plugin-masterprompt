/**
 * 把本地目录推成一个 fork 仓库的一次提交。
 *
 * 和 life 仓库里 push_via_api.mjs 的区别:那个靠本地 git 历史算 diff,
 * 但本机拉 github.com 的历史经常超时。这里不拉历史,改成:
 *   - 用 API 拿远端分支的 tree(每个路径的 blob sha);
 *   - 用 git hash-object 算本地每个文件的 blob sha;
 *   - 两边一比,得到 新增/修改/删除;
 *   - 再走 Git Data API 建 tree(base_tree 用远端) -> 建 commit(parents 用远端头) -> 挪 ref。
 *
 * 用法: node push_fork.mjs <owner/repo> <本地目录> [branch] [message] [--dry]
 * 凭据从 git credential fill 里拿,不落盘、不打印。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const [repo, dir, branch = 'main', message = 'sync'] = args.filter((a) => a !== '--dry')
if (!repo || !dir) {
  console.error('用法: node push_fork.mjs <owner/repo> <本地目录> [branch] [message] [--dry]')
  process.exit(2)
}
const root = path.resolve(dir)
if (!existsSync(root)) {
  console.error('目录不存在:', root)
  process.exit(2)
}

const token = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
})
  .split('\n')
  .find((l) => l.startsWith('password='))
  ?.slice('password='.length)
if (!token) {
  console.error('拿不到 GitHub 凭据')
  process.exit(2)
}

const API = 'https://api.github.com'
const headers = {
  Authorization: `token ${token}`,
  'User-Agent': 'dsh-plugin-publisher',
  Accept: 'application/vnd.github+json',
}
async function api(method, p, body) {
  const res = await fetch(API + p, {
    method,
    headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : undefined
}

/** 走一遍目录,返回相对路径(用 / 分隔)。跳过 .git 和临时目录。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', 'preview', 'src', 'backup'])
function walk(base = '') {
  const out = []
  for (const name of readdirSync(path.join(root, base))) {
    if (SKIP_DIRS.has(name)) continue
    // 编辑时留下的备份文件不进仓库
    if (name.includes('.bak')) continue
    const rel = base ? base + '/' + name : name
    const full = path.join(root, rel)
    if (statSync(full).isDirectory()) out.push(...walk(rel))
    else out.push(rel)
  }
  return out
}

/** 本地文件的 blob sha —— 和 git 会存的那份一致(走 clean 过滤,CRLF 会归一)。 */
function blobSha(rel) {
  return execFileSync('git', ['hash-object', path.join(root, rel)], {
    encoding: 'utf8',
    cwd: root,
  }).trim()
}

const ref = await api('GET', `/repos/${repo}/git/ref/heads/${branch}`)
const baseSha = ref.object.sha
const baseCommit = await api('GET', `/repos/${repo}/git/commits/${baseSha}`)
console.log('基线', baseSha.slice(0, 8), String(baseCommit.message).split('\n')[0])

const baseTree = await api('GET', `/repos/${repo}/git/trees/${baseCommit.tree.sha}?recursive=1`)
const remote = new Map()
for (const e of baseTree.tree ?? []) if (e.type === 'blob') remote.set(e.path, e.sha)

const local = new Map()
for (const rel of walk()) local.set(rel, blobSha(rel))

const added = []
const changed = []
const same = []
for (const [rel, sha] of local) {
  if (!remote.has(rel)) added.push(rel)
  else if (remote.get(rel) !== sha) changed.push(rel)
  else same.push(rel)
}
const removed = [...remote.keys()].filter((p) => !local.has(p))

console.log(`本地 ${local.size} 个文件:新增 ${added.length}、修改 ${changed.length}、删除 ${removed.length}、未变 ${same.length}`)
for (const f of added) console.log('  + ' + f)
for (const f of changed) console.log('  ~ ' + f)
for (const f of removed) console.log('  - ' + f)

if (!added.length && !changed.length && !removed.length) {
  console.log('远端已经一致,什么都不用推')
  process.exit(0)
}
if (dry) {
  console.log('(--dry,没有推)')
  process.exit(0)
}

const tree = []
for (const f of removed) tree.push({ path: f, mode: '100644', type: 'blob', sha: null })
for (const f of [...added, ...changed]) {
  const content = readFileSync(path.join(root, f))
  const blob = await api('POST', `/repos/${repo}/git/blobs`, {
    content: content.toString('base64'),
    encoding: 'base64',
  })
  tree.push({ path: f, mode: '100644', type: 'blob', sha: blob.sha })
  console.log('  写入', f, (content.length / 1024).toFixed(1) + 'K')
}

const newTree = await api('POST', `/repos/${repo}/git/trees`, { base_tree: baseCommit.tree.sha, tree })
const newCommit = await api('POST', `/repos/${repo}/git/commits`, {
  message,
  tree: newTree.sha,
  parents: [baseSha],
})
await api('PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: newCommit.sha })
console.log('推上去了:', newCommit.sha.slice(0, 8))
console.log('https://github.com/' + repo + '/commit/' + newCommit.sha)
