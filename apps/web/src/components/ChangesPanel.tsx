import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileDiff, Folder, RefreshCw, Server } from 'lucide-react'
import type { ChangedFile } from '@agentdeck/shared'
import { showDiff, usePreviewPath } from './FilePreview'
import { FilesPanel } from './FilesPanel'
import { ServicesPanel, useServices } from './ServicesPanel'
import { api } from '../api'
import { useResizable } from './Resizer'
import { dialog } from './Dialog'
import { useSessions } from '../session/useSessions'
import styles from './ChangesPanel.module.css'

// 项目侧栏（桌面端）：改动 diff、文件管理与项目服务。
// version 在一轮结束 / 工具完成时递增，面板据此节流刷新，不轮询。

type Props = { sessionId: string; cwd: string; version: number; busy: boolean }

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

type TreeProps = { node: TreeNode; depth: number; previewing?: string; onSelect: (path: string) => void }
function Tree({ node, depth, previewing, onSelect }: TreeProps) {
  return (
    <>
      {node.dirs.map((d) => (
        <div key={d.name}>
          <div className={styles.dir} style={{ paddingLeft: 8 + depth * 14 }}>
            <Folder size={14} />
            <span className={styles.dirName}>{d.name}</span>
          </div>
          <Tree node={d} depth={depth + 1} previewing={previewing} onSelect={onSelect} />
        </div>
      ))}
      {node.files.map((f) => (
        <button key={f.path} type="button" className={styles.file} data-active={previewing === f.path || undefined} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onSelect(f.path)} title={f.path}>
          <span className={styles.fileName}>{f.path.split('/').pop()}</span>
          <FileStat f={f} />
        </button>
      ))}
    </>
  )
}

export function ChangesPanel({ sessionId, cwd, version, busy }: Props) {
  const client = useQueryClient()
  const changes = useQuery({ queryKey: ['changes', sessionId], queryFn: () => api.listChanges(sessionId) })
  const sessions = useSessions()
  const activeSessions = sessions.data?.filter((s) => s.status === 'running' || s.status === 'waiting_user' || (s.backgroundTasks ?? 0) > 0).map((s) => s.id).sort().join(',')
  const [discarding, setDiscarding] = useState(false)
  const previewing = usePreviewPath(sessionId)
  const [tab, setTab] = useState<'changes' | 'files' | 'services'>('changes')
  // 事件密集时（一轮里连着几十次 Edit）合并成 1.5s 一次
  const { refetch } = changes
  useEffect(() => {
    const t = setTimeout(() => refetch(), 1500)
    return () => clearTimeout(t)
  }, [version, busy, activeSessions, refetch])
  const { width, handle } = useResizable('changes', 380, 280, 720, 'right')
  const services = useServices()
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: api.listWorkspaces })
  const workspaceId = workspaces.data?.find((w) => w.path === cwd)?.id

  const files = changes.data?.files ?? []
  // diff 弹窗打开期间列表可能刷新：丢弃时按路径取最新的 Git 状态和忙碌状态
  const latest = useRef({ files, busy })
  useEffect(() => { latest.current = { files, busy } })
  const discard = async (path: string) => {
    const file = latest.current.files.find((f) => f.path === path)
    const reason = !file ? 'File is no longer in Changes; refresh and try again' : file.discardDisabled ?? (latest.current.busy ? 'Wait for the current task to finish' : undefined)
    if (!file || reason) {
      await dialog.alert({ title: 'Could not discard changes', message: reason! })
      return false
    }
    setDiscarding(true)
    try {
      const confirmed = await dialog.confirm({
        title: file.discard === 'delete' ? 'Delete added file?' : 'Discard changes?',
        message: `${file.path}\n\n${file.discard === 'delete' ? 'This file is not in the last commit. It will be deleted and removed from staging.' : 'Restore this file to the last commit (HEAD), discarding both staged and unstaged changes.'}\n\nThis affects all uncommitted changes to this file, including changes made before this session. This cannot be undone here.`,
        ok: file.discard === 'delete' ? 'Delete file' : 'Discard changes', danger: true,
      })
      if (!confirmed) return false
      await api.discardChange(sessionId, { path: file.path, base: file.base, discard: file.discard })
      return true
    } catch (err) {
      await dialog.alert({ title: 'Could not discard changes', message: (err as Error).message })
      return false
    } finally {
      await Promise.all(['changes', 'diff', 'file', 'projectFiles', 'output'].map((key) => client.invalidateQueries({ queryKey: [key] })))
      setDiscarding(false)
    }
  }
  return (
    <aside className={styles.panel} style={{ width }}>
      <div {...handle} />
      <header className={styles.head}>
        <button type="button" className={styles.tab} aria-pressed={tab === 'changes'} onClick={() => setTab('changes')}><FileDiff size={14} />Changes{changes.data?.git && <code className={styles.count}>{files.length}</code>}</button>
        <button type="button" className={styles.tab} aria-pressed={tab === 'files'} onClick={() => setTab('files')}><Folder size={14} />Files</button>
        <button type="button" className={styles.tab} aria-pressed={tab === 'services'} onClick={() => setTab('services')}><Server size={14} />Services{services.data?.some((s) => s.running && workspaceId === s.workspaceId) && <span className={styles.runningDot} />}</button>
      </header>
      <section className={styles.filesPane} style={{ display: tab === 'changes' ? 'flex' : 'none' }}>
      <div className={styles.sectionHead}>
        <span>Working tree</span>
        <button type="button" className={styles.iconButton} onClick={() => refetch()} disabled={changes.isFetching} aria-label="Refresh" title="Refresh changes">
          <RefreshCw size={14} className={changes.isFetching ? styles.spin : undefined} />
        </button>
      </div>
      <div className={styles.body}>
        {changes.error ? (
          <div className={styles.empty}>{changes.error.message}</div>
        ) : changes.data && !changes.data.git ? (
          <div className={styles.empty}>Not a git repository</div>
        ) : files.length === 0 ? (
          <div className={styles.empty}>{changes.data ? 'Working tree clean' : '…'}</div>
        ) : (
          <Tree node={buildTree(files)} depth={0} previewing={previewing} onSelect={(path) => showDiff(sessionId, path, discard)} />
        )}
      </div>
      </section>
      <FilesPanel key={sessionId} sessionId={sessionId} active={tab === 'files'} version={version} busy={busy || discarding} activity={activeSessions} />
      <ServicesPanel key={cwd} cwd={cwd} active={tab === 'services'} />
    </aside>
  )
}
