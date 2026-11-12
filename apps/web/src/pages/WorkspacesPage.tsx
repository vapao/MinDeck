import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, CornerLeftUp, Folder, FolderOpen, FolderPlus, MessageSquarePlus, Pencil, SquareTerminal, Trash2, X } from 'lucide-react'
import { api } from '../api'
import { backToTab } from '../router'
import { dialog } from '../components/Dialog'
import { openProjectFinder, openProjectTerminal } from '../components/FilePreview'
import { openNewSession } from '../components/NewSessionDialog'
import { useMediaQuery } from '../session/useMediaQuery'
import modal from '../components/Dialog.module.css'
import styles from './Manage.module.css'
import layout from './WorkspacesPage.module.css'

// 项目管理：列表（新建会话 / Finder / iTerm2 / 改别名 / 移除）+ 弹窗里从家目录内浏览目录添加。移除只是从列表去掉，会话记录不动
export function WorkspacesPage() {
  const queryClient = useQueryClient()
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: api.listWorkspaces })
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['workspaces'] })
  const remove = useMutation({ mutationFn: api.deleteWorkspace, onSuccess: invalidate })
  const rename = useMutation({ mutationFn: ({ id, alias }: { id: string; alias: string }) => api.updateWorkspace(id, { alias }), onSuccess: invalidate })
  const [adding, setAdding] = useState(false)
  // Finder / Terminal 唤起浏览器这台 Mac 上的 helper，只在桌面显示
  const desktop = useMediaQuery('(min-width: 1024px)')

  const onRename = async (id: string, current: string) => {
    const alias = (await dialog.prompt({ title: 'Project alias', initial: current, ok: 'Save' }))?.trim()
    if (alias && alias !== current) rename.mutate({ id, alias })
  }
  const onRemove = async (id: string, alias: string) => {
    if (await dialog.confirm({ title: `Remove "${alias}" from the list?`, message: 'Existing sessions in this directory are not affected. Its services are removed too.', ok: 'Remove', danger: true })) remove.mutate(id)
  }
  const error = workspaces.error ?? remove.error ?? rename.error

  return (
    <div className={styles.page}>
      <div className={`${styles.card} ${layout.card}`}>
        <div className={styles.head}>
          <button type="button" className={styles.back} onClick={() => backToTab()} aria-label="Back">
            <ChevronLeft size={18} />
          </button>
          <h1 className={styles.title}>Projects</h1>
          {workspaces.data && <span className={layout.count}>{workspaces.data.length}</span>}
          <button type="button" className={`${styles.primary} ${layout.add}`} onClick={() => setAdding(true)}>
            <FolderPlus size={16} />
            Add project
          </button>
        </div>
        {error && <div className={styles.error}>{error.message}</div>}
        <div className={`${styles.scroll} ${layout.list}`}>
          {workspaces.data?.length === 0 && <div className={styles.empty}>No projects yet</div>}
          {workspaces.data?.map((w) => (
            <div key={w.id} className={layout.item}>
              <Folder size={16} />
              <div className={layout.main}>
                <span className={layout.name} title={w.alias}>{w.alias}</span>
                <code className={layout.path} title={w.path}>{w.path}</code>
              </div>
              <div className={layout.actions}>
                <button type="button" className={styles.rowButton} onClick={() => openNewSession(w.path)} aria-label="New session" title="New session">
                  <MessageSquarePlus size={14} />
                </button>
                {desktop && (
                  <>
                    <button type="button" className={styles.rowButton} onClick={() => openProjectFinder(w.path)} aria-label="Open in Finder" title="Open this project folder in Finder">
                      <FolderOpen size={14} />
                    </button>
                    <button type="button" className={styles.rowButton} onClick={() => openProjectTerminal(w.path)} aria-label="Open in Terminal" title="Open a terminal in this project">
                      <SquareTerminal size={14} />
                    </button>
                  </>
                )}
                <button type="button" className={styles.rowButton} onClick={() => onRename(w.id, w.alias)} aria-label="Rename" title="Rename">
                  <Pencil size={14} />
                </button>
                <button type="button" className={styles.rowButton} data-danger onClick={() => onRemove(w.id, w.alias)} disabled={remove.isPending} aria-label="Remove" title="Remove">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
        {adding && <DirPicker onClose={() => setAdding(false)} />}
      </div>
    </div>
  )
}

// 目录浏览弹窗：一层一层进，选中当前目录后填别名（默认目录名）。加完大概率要开工，直接去新建会话并选中它
function DirPicker({ onClose }: { onClose: () => void }) {
  const el = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (!el.current!.open) el.current!.showModal()
  }, [])
  const queryClient = useQueryClient()
  const [path, setPath] = useState<string | undefined>(undefined)
  const [alias, setAlias] = useState('')
  const dirs = useQuery({ queryKey: ['dirs', path], queryFn: () => api.listDirs(path) })
  const create = useMutation({
    mutationFn: api.createWorkspace,
    onSuccess: (workspace) => {
      queryClient.invalidateQueries({ queryKey: ['workspaces'] })
      el.current!.close()
      openNewSession(workspace.path)
    },
  })
  const current = dirs.data?.path
  const enter = (p: string) => {
    setPath(p)
    setAlias('')
  }

  return (
    <dialog ref={el} className={modal.dialog} style={{ width: 'min(calc(100vw - 32px), 560px)' }} onClose={onClose} onClick={(e) => e.target === el.current && el.current.close()}>
      <div className={modal.box}>
        <div className={modal.head}>
          <div className={modal.title}>Add project</div>
          <button type="button" className={modal.close} onClick={() => el.current!.close()} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className={styles.dialogBody}>
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
              {dirs.data?.dirs.length === 0 && <div className={styles.empty}>No subdirectories</div>}
            </div>
          </div>
          <label className={styles.field}>
            <span>Alias</span>
            <input className={styles.input} value={alias} placeholder={current?.split('/').pop()} onChange={(e) => setAlias(e.target.value)} />
          </label>
          {(dirs.error ?? create.error) && <div className={styles.error}>{(dirs.error ?? create.error)!.message}</div>}
        </div>
        <div className={modal.actions}>
          <button type="button" className={modal.secondary} onClick={() => el.current!.close()}>
            Cancel
          </button>
          <button
            type="button"
            className={modal.primary}
            disabled={!current || create.isPending}
            onClick={() => create.mutate({ path: current!, alias: alias.trim() || current!.split('/').pop()! })}
          >
            Add this directory
          </button>
        </div>
      </div>
    </dialog>
  )
}
