import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, CornerLeftUp, Folder, FolderPlus, Pencil, Trash2 } from 'lucide-react'
import { api } from '../api'
import { navigate } from '../router'
import styles from './Manage.module.css'

// 项目管理：列表（改别名 / 移除）+ 从家目录内浏览目录添加。移除只是从列表去掉，会话记录不动
export function WorkspacesPage() {
  const queryClient = useQueryClient()
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: api.listWorkspaces })
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['workspaces'] })
  const remove = useMutation({ mutationFn: api.deleteWorkspace, onSuccess: invalidate })
  const rename = useMutation({ mutationFn: ({ id, alias }: { id: string; alias: string }) => api.updateWorkspace(id, { alias }), onSuccess: invalidate })
  const [adding, setAdding] = useState(false)

  const onRename = (id: string, current: string) => {
    const alias = prompt('项目别名', current)?.trim()
    if (alias && alias !== current) rename.mutate({ id, alias })
  }
  const onRemove = (id: string, alias: string) => {
    if (confirm(`从列表移除「${alias}」？该目录下已有的会话不受影响。`)) remove.mutate(id)
  }
  const error = workspaces.error ?? remove.error ?? rename.error

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.head}>
          <button type="button" className={styles.back} onClick={() => navigate('/')} aria-label="返回">
            <ChevronLeft size={18} />
          </button>
          <h1 className={styles.title}>项目</h1>
        </div>
        <div className={styles.rows}>
          {workspaces.data?.length === 0 && <div className={styles.empty}>还没有项目</div>}
          {workspaces.data?.map((w) => (
            <div key={w.id} className={styles.row}>
              <Folder size={16} />
              <div className={styles.rowBody}>
                <span className={styles.rowTitle}>{w.alias}</span>
                <code className={styles.rowPath} title={w.path}>{w.path}</code>
              </div>
              <button type="button" className={styles.rowButton} onClick={() => onRename(w.id, w.alias)} aria-label="改别名">
                <Pencil size={14} />
              </button>
              <button type="button" className={styles.rowButton} data-danger onClick={() => onRemove(w.id, w.alias)} disabled={remove.isPending} aria-label="移除">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
        {adding ? (
          <DirPicker onDone={() => setAdding(false)} />
        ) : (
          <div className={styles.actions}>
            <button type="button" className={styles.primary} onClick={() => setAdding(true)}>
              <FolderPlus size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />
              添加项目
            </button>
          </div>
        )}
        {error && <div className={styles.error}>{error.message}</div>}
      </div>
    </div>
  )
}

// 目录浏览：一层一层进，选中当前目录后填别名（默认目录名）
function DirPicker({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient()
  const [path, setPath] = useState<string | undefined>(undefined)
  const [alias, setAlias] = useState('')
  const dirs = useQuery({ queryKey: ['dirs', path], queryFn: () => api.listDirs(path) })
  const create = useMutation({
    mutationFn: api.createWorkspace,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspaces'] })
      onDone()
    },
  })
  const current = dirs.data?.path
  const enter = (p: string) => {
    setPath(p)
    setAlias('')
  }

  return (
    <>
      <div className={styles.section}>选择项目根目录</div>
      <div className={styles.rows}>
        <div className={styles.crumb}>{current ?? '…'}</div>
        <div className={styles.dirList}>
          {dirs.data?.parent && (
            <button type="button" className={styles.dirButton} onClick={() => enter(dirs.data!.parent!)}>
              <CornerLeftUp size={14} />
              ..
            </button>
          )}
          {dirs.data?.dirs.map((d) => (
            <button key={d.path} type="button" className={styles.dirButton} onClick={() => enter(d.path)}>
              <Folder size={14} />
              <span style={{ flex: 1 }}>{d.name}</span>
              <ChevronRight size={14} />
            </button>
          ))}
          {dirs.data?.dirs.length === 0 && <div className={styles.empty}>没有子目录</div>}
        </div>
      </div>
      <label className={styles.field}>
        <span>别名</span>
        <input className={styles.input} value={alias} placeholder={current?.split('/').pop()} onChange={(e) => setAlias(e.target.value)} />
      </label>
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={onDone}>
          取消
        </button>
        <button
          type="button"
          className={styles.primary}
          disabled={!current || create.isPending}
          onClick={() => create.mutate({ path: current!, alias: alias.trim() || current!.split('/').pop()! })}
        >
          添加当前目录
        </button>
      </div>
      {(dirs.error ?? create.error) && <div className={styles.error}>{(dirs.error ?? create.error)!.message}</div>}
    </>
  )
}
