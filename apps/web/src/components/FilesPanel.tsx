import { useEffect, useState } from 'react'
import { useQuery, useQueryClient, useIsFetching } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, File, Folder, RefreshCw, Search, X } from 'lucide-react'
import { api } from '../api'
import { showFile } from './FilePreview'
import styles from './ChangesPanel.module.css'

type Props = { sessionId: string; active: boolean; version: number }

export function FilesPanel({ sessionId, active, version }: Props) {
  const client = useQueryClient()
  const [hidden, setHidden] = useState(() => localStorage.getItem('files:showHidden') === 'true')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const fetching = useIsFetching({ queryKey: ['projectFiles', sessionId] }) > 0
  const refresh = () => client.invalidateQueries({ queryKey: ['projectFiles', sessionId] })
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250)
    return () => clearTimeout(timer)
  }, [search])
  useEffect(() => {
    const timer = setTimeout(() => { void client.invalidateQueries({ queryKey: ['projectFiles', sessionId] }) }, 1500)
    return () => clearTimeout(timer)
  }, [version, sessionId, client])
  const results = useQuery({
    queryKey: ['projectFiles', sessionId, 'search', query, hidden],
    queryFn: () => api.listProjectFiles(sessionId, '', query, hidden),
    enabled: active && !!query,
  })
  const searching = !!search.trim()
  return <div className={styles.filesPane} style={{ display: active ? 'flex' : 'none' }}>
    <div className={styles.fileControls}>
      <div className={styles.searchBox}>
        <Search size={14} />
        <input aria-label="Search project files" placeholder="Search files by name or path…" value={search} onChange={(e) => setSearch(e.target.value)} />
        {search && <button type="button" className={styles.iconButton} aria-label="Clear file search" onClick={() => { setSearch(''); setQuery('') }}><X size={14} /></button>}
      </div>
      <div className={styles.fileOptions}>
        <label><input type="checkbox" checked={hidden} onChange={(e) => { setHidden(e.target.checked); localStorage.setItem('files:showHidden', String(e.target.checked)) }} />Show hidden files</label>
        <button type="button" className={styles.iconButton} onClick={refresh} disabled={fetching} aria-label="Refresh files"><RefreshCw size={14} className={fetching ? styles.spin : undefined} /></button>
      </div>
    </div>
    <div className={styles.body} hidden={searching}>
      <Directory sessionId={sessionId} path="" depth={0} hidden={hidden} active={active && !searching} expanded={expanded} toggle={(path) => setExpanded((prev) => { const next = new Set(prev); if (next.has(path)) next.delete(path); else next.add(path); return next })} />
    </div>
    {searching && <div className={styles.body}>
      {query !== search.trim() || results.isPending ? <div className={styles.empty}>Searching…</div> : results.error ? <div className={styles.empty}>{results.error.message}</div> : <>
        {results.data.entries.map((file) => <button type="button" key={file.path} className={`${styles.file} ${styles.searchResult}`} title={file.path} onClick={() => showFile(sessionId, file.path)}>
          <File size={14} /><span className={styles.resultText}><span>{file.name}</span><span className={styles.resultPath}>{file.path}</span></span>
        </button>)}
        {results.data.truncated ? <div className={styles.empty}>Search limit reached. Results are incomplete; narrow your search.</div> : results.data.entries.length === 0 && <div className={styles.empty}>No files found</div>}
      </>}
    </div>}
  </div>
}

type DirectoryProps = { sessionId: string; path: string; depth: number; hidden: boolean; active: boolean; expanded: Set<string>; toggle: (path: string) => void }
function Directory({ sessionId, path, depth, hidden, active, expanded, toggle }: DirectoryProps) {
  const q = useQuery({ queryKey: ['projectFiles', sessionId, 'dir', path, hidden], queryFn: () => api.listProjectFiles(sessionId, path, '', hidden), enabled: active })
  if (q.error) return <div className={styles.empty}>{q.error.message}</div>
  if (!q.data) return <div className={styles.empty}>Loading…</div>
  if (!q.data.entries.length) return <div className={styles.empty}>Empty folder</div>
  return <>{q.data.entries.map((file) => <div key={file.path}>
    <button type="button" className={styles.file} style={{ paddingLeft: 8 + depth * 14 }} title={file.path} aria-expanded={file.dir ? expanded.has(file.path) : undefined} onClick={() => file.dir ? toggle(file.path) : showFile(sessionId, file.path)}>
      {file.dir ? <>{expanded.has(file.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<Folder size={14} /></> : <File size={14} style={{ marginLeft: 20 }} />}
      <span className={styles.fileName}>{file.name}</span>
    </button>
    {file.dir && expanded.has(file.path) && <Directory sessionId={sessionId} path={file.path} depth={depth + 1} hidden={hidden} active={active} expanded={expanded} toggle={toggle} />}
  </div>)}</>
}
