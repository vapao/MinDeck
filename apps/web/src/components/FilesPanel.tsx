import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { useQuery, useQueryClient, useIsFetching } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, File, FilePlus, Folder, FolderPlus, RefreshCw, Search, Trash2, X } from 'lucide-react'
import type { DeleteProjectEntryBody as Entry } from '@agentdeck/shared'
import { api } from '../api'
import { showFile, usePreviewPath } from './FilePreview'
import { dialog } from './Dialog'
import styles from './ChangesPanel.module.css'

type Actions = { disabled?: string; onCreate: (parent: string, dir: boolean) => void; onDelete: (entry: Entry) => void }
type Props = { sessionId: string; active: boolean; version: number; busy: boolean; activity?: string }

export function FilesPanel({ sessionId, active, version, busy, activity }: Props) {
  const client = useQueryClient()
  const previewing = usePreviewPath(sessionId)
  const [hidden, setHidden] = useState(() => localStorage.getItem('files:showHidden') === 'true')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [writing, setWriting] = useState(false)
  const rootFiles = useQuery({ queryKey: ['projectFiles', sessionId, 'dir', '', hidden], queryFn: () => api.listProjectFiles(sessionId, '', '', hidden), enabled: active })
  const disabled = busy ? 'Wait for the current task to finish' : writing ? 'File operation in progress' : rootFiles.data?.writeDisabled ?? (!rootFiles.data || rootFiles.error ? 'Refresh files before making changes' : undefined)
  const fetching = useIsFetching({ queryKey: ['projectFiles', sessionId] }) > 0
  const refresh = () => client.invalidateQueries({ queryKey: ['projectFiles', sessionId] })
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250)
    return () => clearTimeout(timer)
  }, [search])
  useEffect(() => {
    const timer = setTimeout(() => { void client.invalidateQueries({ queryKey: ['projectFiles', sessionId] }) }, 1500)
    return () => clearTimeout(timer)
  }, [version, busy, activity, sessionId, client])
  const results = useQuery({
    queryKey: ['projectFiles', sessionId, 'search', query, hidden],
    queryFn: () => api.listProjectFiles(sessionId, '', query, hidden),
    enabled: active && !!query,
  })
  const searching = !!search.trim()
  const invalidate = () => Promise.all(['projectFiles', 'changes', 'diff', 'file', 'output'].map((key) => client.invalidateQueries({ queryKey: [key] })))
  const create = async (parent: string, dir: boolean) => {
    if (disabled) return
    setWriting(true)
    try {
      const value = await dialog.prompt({ title: dir ? 'New folder' : 'New file', message: `Create ${dir ? 'a folder' : 'an empty file'} in ${parent || 'the project root'}.`, placeholder: dir ? 'Folder name' : 'File name', ok: 'Create' })
      if (value === null) return
      const name = value.trim()
      if (!name || name.includes('/') || name === '.' || name === '..' || name.toLowerCase() === '.git') throw new Error('Enter a single file or folder name, without slashes. Git metadata is protected.')
      await api.createProjectEntry(sessionId, { path: parent ? `${parent}/${name}` : name, dir })
      setSearch('')
      setQuery('')
      if (parent) setExpanded((prev) => new Set([...prev, parent]))
    } catch (err) {
      await dialog.alert({ title: 'Could not create entry', message: (err as Error).message })
    } finally {
      await invalidate()
      setWriting(false)
    }
  }
  const remove = async (entry: Entry) => {
    if (disabled) return
    setWriting(true)
    try {
      if (!await dialog.confirm({
        title: entry.dir ? 'Delete folder and its contents?' : 'Delete file?',
        message: `${entry.path}\n\n${entry.dir ? 'Permanently delete this folder and everything inside, including hidden, ignored and untracked files.' : 'Permanently delete this file. If this entry is a symbolic link, only the link is deleted.'}\n\nThis does not move anything to Trash. Uncommitted content may not be recoverable with Git.`,
        ok: entry.dir ? 'Delete folder' : 'Delete file', danger: true,
      })) return
      await api.deleteProjectEntry(sessionId, { path: entry.path, dir: entry.dir })
      // 先卸载已删除目录的查询，再刷新缓存，避免请求已经不存在的目录。
      flushSync(() => setExpanded((prev) => new Set([...prev].filter((path) => path !== entry.path && !path.startsWith(entry.path + '/')))))
    } catch (err) {
      await dialog.alert({ title: 'Could not delete entry', message: (err as Error).message })
    } finally {
      await invalidate()
      setWriting(false)
    }
  }
  const actions: Actions = { disabled, onCreate: create, onDelete: remove }
  return <div className={styles.filesPane} style={{ display: active ? 'flex' : 'none' }}>
    <div className={styles.fileControls}>
      <div className={styles.searchBox}>
        <Search size={14} />
        <input aria-label="Search project files" placeholder="Search files by name or path…" value={search} onChange={(e) => setSearch(e.target.value)} />
        {search && <button type="button" className={styles.iconButton} aria-label="Clear file search" onClick={() => { setSearch(''); setQuery('') }}><X size={14} /></button>}
      </div>
      <div className={styles.fileOptions}>
        <label><input type="checkbox" checked={hidden} onChange={(e) => { setHidden(e.target.checked); localStorage.setItem('files:showHidden', String(e.target.checked)) }} />Show hidden files</label>
        <span className={styles.fileActions}>
          <EntryActions path="" dir {...actions} />
          <button type="button" className={styles.iconButton} onClick={refresh} disabled={fetching} aria-label="Refresh files"><RefreshCw size={14} className={fetching ? styles.spin : undefined} /></button>
        </span>
      </div>
    </div>
    <div className={styles.body} hidden={searching}>
      <Directory sessionId={sessionId} path="" depth={0} hidden={hidden} active={active && !searching} expanded={expanded} actions={actions} toggle={(path) => setExpanded((prev) => { const next = new Set(prev); if (next.has(path)) next.delete(path); else next.add(path); return next })} />
    </div>
    {searching && <div className={styles.body}>
      {query !== search.trim() || results.isPending ? <div className={styles.empty}>Searching…</div> : results.error ? <div className={styles.empty}>{results.error.message}</div> : <>
        {results.data.entries.map((file) => <div key={file.path} className={styles.fileRow}>
          <button type="button" className={`${styles.file} ${styles.searchResult}`} data-active={previewing === file.path || undefined} title={file.path} onClick={() => showFile(sessionId, file.path)}>
            <File size={14} /><span className={styles.resultText}><span>{file.name}</span><span className={styles.resultPath}>{file.path}</span></span>
          </button>
          <EntryActions {...file} {...actions} />
        </div>)}
        {results.data.truncated ? <div className={styles.empty}>Search limit reached. Results are incomplete; narrow your search.</div> : results.data.entries.length === 0 && <div className={styles.empty}>No files found</div>}
      </>}
    </div>}
  </div>
}

function EntryActions({ path, dir, disabled, onCreate, onDelete }: { path: string; dir: boolean } & Actions) {
  const reason = path.split('/').some((part) => part.toLowerCase() === '.git') ? 'Git metadata is protected' : disabled
  return <span className={styles.fileActions}>
    {dir && <>
      <button type="button" className={styles.iconButton} disabled={!!reason} title={reason ?? 'New file'} aria-label={`New file in ${path || 'project root'}`} onClick={() => onCreate(path, false)}><FilePlus size={14} /></button>
      <button type="button" className={styles.iconButton} disabled={!!reason} title={reason ?? 'New folder'} aria-label={`New folder in ${path || 'project root'}`} onClick={() => onCreate(path, true)}><FolderPlus size={14} /></button>
    </>}
    {path && <button type="button" className={styles.iconButton} disabled={!!reason} title={reason ?? (dir ? 'Delete folder' : 'Delete file')} aria-label={`Delete ${path}`} onClick={() => onDelete({ path, dir })}><Trash2 size={14} /></button>}
  </span>
}

type DirectoryProps = { sessionId: string; path: string; depth: number; hidden: boolean; active: boolean; expanded: Set<string>; toggle: (path: string) => void; actions: Actions }
function Directory({ sessionId, path, depth, hidden, active, expanded, toggle, actions }: DirectoryProps) {
  const previewing = usePreviewPath(sessionId)
  const q = useQuery({ queryKey: ['projectFiles', sessionId, 'dir', path, hidden], queryFn: () => api.listProjectFiles(sessionId, path, '', hidden), enabled: active })
  if (q.error) return <div className={styles.empty}>{q.error.message}</div>
  if (!q.data) return <div className={styles.empty}>Loading…</div>
  if (!q.data.entries.length) return <div className={styles.empty}>Empty folder</div>
  return <>{q.data.entries.map((file) => <div key={file.path}>
    <div className={styles.fileRow}>
      <button type="button" className={styles.file} data-active={previewing === file.path || undefined} style={{ paddingLeft: 8 + depth * 14 }} title={file.path} aria-expanded={file.dir ? expanded.has(file.path) : undefined} onClick={() => file.dir ? toggle(file.path) : showFile(sessionId, file.path)}>
        {file.dir ? <>{expanded.has(file.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<Folder size={14} /></> : <File size={14} style={{ marginLeft: 20 }} />}
        <span className={styles.fileName}>{file.name}</span>
      </button>
      <EntryActions {...file} {...actions} />
    </div>
    {file.dir && expanded.has(file.path) && <Directory sessionId={sessionId} path={file.path} depth={depth + 1} hidden={hidden} active={active} expanded={expanded} toggle={toggle} actions={actions} />}
  </div>)}</>
}
