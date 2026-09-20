import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, FileCode, FileDiff, Folder, RefreshCw } from 'lucide-react'
import type { ChangedFile } from '@agentdeck/shared'
import { api } from '../api'
import { useResizable } from './Resizer'
import styles from './ChangesPanel.module.css'

// 改动侧栏（桌面端）：工作区相对 HEAD 改了哪些文件；点开看 diff，或直接看整个文件。只读。
// version 在一轮结束 / 工具完成时递增，面板据此节流刷新，不轮询。

type Props = { sessionId: string; version: number }

// 目录树：只含有改动的路径；只有一个子目录的目录链压成一行（apps/web/src）
type TreeNode = { name: string; dirs: TreeNode[]; files: ChangedFile[] }

function buildTree(files: ChangedFile[]): TreeNode {
  const root: TreeNode = { name: '', dirs: [], files: [] }
  for (const f of files) {
    const segs = f.path.split('/')
    let node = root
    for (const seg of segs.slice(0, -1)) {
      let next = node.dirs.find((d) => d.name === seg)
      if (!next) node.dirs.push((next = { name: seg, dirs: [], files: [] }))
      node = next
    }
    node.files.push(f)
  }
  const compact = (n: TreeNode): TreeNode => {
    while (n.dirs.length === 1 && n.files.length === 0 && n !== root) n = { ...n.dirs[0], name: `${n.name}/${n.dirs[0].name}` }
    return { ...n, dirs: n.dirs.map(compact) }
  }
  return compact(root)
}

// 右侧统计：修改显示 +加 −减；新增 / 删除 / 重命名只给一个字母
function FileStat({ f }: { f: ChangedFile }) {
  if (f.status === '?' || f.status === 'A') return <span className={styles.stat} data-kind="add">A</span>
  if (f.status === 'D') return <span className={styles.stat} data-kind="del">D</span>
  return (
    <span className={styles.stat}>
      {f.status === 'R' && <span data-kind="rename">R</span>}
      {f.additions !== null && f.additions > 0 && <span data-kind="add">+{f.additions}</span>}
      {f.deletions !== null && f.deletions > 0 && <span data-kind="del">−{f.deletions}</span>}
    </span>
  )
}

function Tree({ node, depth, onSelect }: { node: TreeNode; depth: number; onSelect: (path: string) => void }) {
  return (
    <>
      {node.dirs.map((d) => (
        <div key={d.name}>
          <div className={styles.dir} style={{ paddingLeft: 8 + depth * 14 }}>
            <Folder size={14} />
            <span className={styles.dirName}>{d.name}</span>
          </div>
          <Tree node={d} depth={depth + 1} onSelect={onSelect} />
        </div>
      ))}
      {node.files.map((f) => (
        <button key={f.path} type="button" className={styles.file} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onSelect(f.path)} title={f.path}>
          <span className={styles.fileName}>{f.path.split('/').pop()}</span>
          <FileStat f={f} />
        </button>
      ))}
    </>
  )
}

export function ChangesPanel({ sessionId, version }: Props) {
  const changes = useQuery({ queryKey: ['changes', sessionId], queryFn: () => api.listChanges(sessionId) })
  const [selected, setSelected] = useState<string | null>(null)
  const [view, setView] = useState<'diff' | 'file'>('diff')
  // 事件密集时（一轮里连着几十次 Edit）合并成 1.5s 一次
  const { refetch } = changes
  useEffect(() => {
    const t = setTimeout(() => refetch(), 1500)
    return () => clearTimeout(t)
  }, [version, refetch])
  useEffect(() => setSelected(null), [sessionId])
  const { width, handle } = useResizable('changes', 380, 280, 720, 'right')

  if (selected) {
    return (
      <aside className={styles.panel} style={{ width }}>
        <div {...handle} />
        <header className={styles.head}>
          <button type="button" className={styles.iconButton} onClick={() => setSelected(null)} aria-label="Back to list">
            <ChevronLeft size={16} />
          </button>
          <code className={styles.path} title={selected}>{selected}</code>
          <button type="button" className={styles.iconButton} data-active={view === 'diff' || undefined} onClick={() => setView('diff')} title="Diff">
            <FileDiff size={15} />
          </button>
          <button type="button" className={styles.iconButton} data-active={view === 'file' || undefined} onClick={() => setView('file')} title="Whole file">
            <FileCode size={15} />
          </button>
        </header>
        {view === 'diff' ? <DiffView key={`${sessionId}:${selected}:${version}`} sessionId={sessionId} path={selected} /> : <FileView key={`${sessionId}:${selected}:${version}`} sessionId={sessionId} path={selected} />}
      </aside>
    )
  }

  const files = changes.data?.files ?? []
  return (
    <aside className={styles.panel} style={{ width }}>
      <div {...handle} />
      <header className={styles.head}>
        <span className={styles.title}>Changes</span>
        {changes.data?.git && <code className={styles.count}>{files.length}</code>}
        <span style={{ flex: 1 }} />
        <button type="button" className={styles.iconButton} onClick={() => refetch()} disabled={changes.isFetching} aria-label="Refresh">
          <RefreshCw size={14} className={changes.isFetching ? styles.spin : undefined} />
        </button>
      </header>
      <div className={styles.body}>
        {changes.error ? (
          <div className={styles.empty}>{changes.error.message}</div>
        ) : changes.data && !changes.data.git ? (
          <div className={styles.empty}>Not a git repository</div>
        ) : files.length === 0 ? (
          <div className={styles.empty}>{changes.data ? 'Working tree clean' : '…'}</div>
        ) : (
          <Tree node={buildTree(files)} depth={0} onSelect={setSelected} />
        )}
      </div>
    </aside>
  )
}

// 自己解析 unified diff 按行着色，不引 diff 库、不做语法高亮
function DiffView({ sessionId, path }: { sessionId: string; path: string }) {
  const q = useQuery({ queryKey: ['diff', sessionId, path], queryFn: () => api.fileDiff(sessionId, path), staleTime: 0 })
  if (q.error) return <div className={styles.empty}>{q.error.message}</div>
  if (!q.data) return <div className={styles.empty}>…</div>
  if (q.data.binary) return <div className={styles.empty}>Binary file</div>
  const lines = q.data.diff.split('\n')
  // 只展示 hunk 内容：文件头四行对用户没信息量
  const body = lines.slice(lines.findIndex((l) => l.startsWith('@@')))
  if (body.length === 0 || !body[0].startsWith('@@')) return <div className={styles.empty}>No differences</div>
  return (
    <pre className={styles.code}>
      {body.map((l, i) => (
        <div key={i} className={styles.line} data-kind={l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : undefined}>
          {l || ' '}
        </div>
      ))}
    </pre>
  )
}

function FileView({ sessionId, path }: { sessionId: string; path: string }) {
  const q = useQuery({ queryKey: ['file', sessionId, path], queryFn: () => api.readFile(sessionId, path), staleTime: 0 })
  if (q.error) return <div className={styles.empty}>{q.error.message}</div>
  if (!q.data) return <div className={styles.empty}>…</div>
  if (q.data.binary || q.data.content === null) return <div className={styles.empty}>Binary file</div>
  const lines = q.data.content.split('\n')
  return (
    <pre className={styles.code}>
      {lines.map((l, i) => (
        <div key={i} className={styles.line}>
          <span className={styles.lineNo}>{i + 1}</span>
          {l || ' '}
        </div>
      ))}
      {q.data.truncated && <div className={styles.empty}>File too large, showing the first 512KB</div>}
    </pre>
  )
}
