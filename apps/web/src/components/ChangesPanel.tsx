import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, FileCode, FileDiff, RefreshCw } from 'lucide-react'
import type { ChangedFile } from '@agentdeck/shared'
import { api } from '../api'
import styles from './ChangesPanel.module.css'

// 改动侧栏（桌面端）：工作区相对 HEAD 改了哪些文件；点开看 diff，或直接看整个文件。只读。
// version 在一轮结束 / 工具完成时递增，面板据此节流刷新，不轮询。

type Props = { sessionId: string; version: number }

const statusText: Record<ChangedFile['status'], string> = { '?': '新', A: '增', M: '改', D: '删', R: '移' }

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

  if (selected) {
    return (
      <aside className={styles.panel}>
        <header className={styles.head}>
          <button type="button" className={styles.iconButton} onClick={() => setSelected(null)} aria-label="返回列表">
            <ChevronLeft size={16} />
          </button>
          <code className={styles.path} title={selected}>{selected}</code>
          <button type="button" className={styles.iconButton} data-active={view === 'diff' || undefined} onClick={() => setView('diff')} title="Diff">
            <FileDiff size={15} />
          </button>
          <button type="button" className={styles.iconButton} data-active={view === 'file' || undefined} onClick={() => setView('file')} title="整个文件">
            <FileCode size={15} />
          </button>
        </header>
        {view === 'diff' ? <DiffView key={`${sessionId}:${selected}:${version}`} sessionId={sessionId} path={selected} /> : <FileView key={`${sessionId}:${selected}:${version}`} sessionId={sessionId} path={selected} />}
      </aside>
    )
  }

  const files = changes.data?.files ?? []
  return (
    <aside className={styles.panel}>
      <header className={styles.head}>
        <span className={styles.title}>改动</span>
        {changes.data?.git && <code className={styles.count}>{files.length}</code>}
        <span style={{ flex: 1 }} />
        <button type="button" className={styles.iconButton} onClick={() => refetch()} disabled={changes.isFetching} aria-label="刷新">
          <RefreshCw size={14} className={changes.isFetching ? styles.spin : undefined} />
        </button>
      </header>
      <div className={styles.body}>
        {changes.error ? (
          <div className={styles.empty}>{changes.error.message}</div>
        ) : changes.data && !changes.data.git ? (
          <div className={styles.empty}>不是 git 仓库</div>
        ) : files.length === 0 ? (
          <div className={styles.empty}>{changes.data ? '工作区干净' : '…'}</div>
        ) : (
          files.map((f) => (
            <button key={f.path} type="button" className={styles.file} onClick={() => setSelected(f.path)} title={f.path}>
              <span className={styles.status} data-status={f.status}>{statusText[f.status]}</span>
              <span className={styles.fileName}>{f.path.split('/').pop()}</span>
              <span className={styles.fileDir}>{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}</span>
            </button>
          ))
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
  if (q.data.binary) return <div className={styles.empty}>二进制文件</div>
  const lines = q.data.diff.split('\n')
  // 只展示 hunk 内容：文件头四行对用户没信息量
  const body = lines.slice(lines.findIndex((l) => l.startsWith('@@')))
  if (body.length === 0 || !body[0].startsWith('@@')) return <div className={styles.empty}>没有差异</div>
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
  if (q.data.binary || q.data.content === null) return <div className={styles.empty}>二进制文件</div>
  const lines = q.data.content.split('\n')
  return (
    <pre className={styles.code}>
      {lines.map((l, i) => (
        <div key={i} className={styles.line}>
          <span className={styles.lineNo}>{i + 1}</span>
          {l || ' '}
        </div>
      ))}
      {q.data.truncated && <div className={styles.empty}>文件过大，只显示前 512KB</div>}
    </pre>
  )
}
