import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '../api'
import { dialog } from './Dialog'
import styles from './FilePreview.module.css'
import modal from './Dialog.module.css'
import manage from '../pages/Manage.module.css'

let selected: { sessionId: string; path: string; line?: number } | null = null
const listeners = new Set<() => void>()
export function showFile(sessionId: string, path: string, line?: number) {
  selected = { sessionId, path, line }
  listeners.forEach((l) => l())
}
export function fileReference(href: string) {
  if (!href || href.startsWith('#') || href.startsWith('//')) return null
  if (/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith('file://') && !href.startsWith('sandbox:')) return null
  let value = href
  if (value.startsWith('file://')) {
    try { const url = new URL(value); if (url.hostname && url.hostname !== 'localhost') return null; value = url.pathname + url.hash } catch { return null }
  }
  value = value.replace(/^sandbox:/, '')
  const match = value.match(/(?::(\d+)(?::\d+)?|#L(\d+)(?:C\d+)?(?:-L?\d+)?)$/)
  if (match) value = value.slice(0, match.index)
  try { return { path: decodeURIComponent(value), line: match ? Number(match[1] ?? match[2]) : undefined } } catch { return null }
}
const mappingKey = 'finder:mapping'
function mapping() { return JSON.parse(localStorage.getItem(mappingKey) ?? '{"remote":"/Users/aka","local":""}') as { remote: string; local: string } }
export function mappedPath(path: string) {
  const { remote, local } = mapping()
  const prefix = remote.replace(/\/+$/, '')
  if (!local || !remote || (path !== prefix && !path.startsWith(prefix + '/'))) return null
  return local.replace(/\/+$/, '') + path.slice(prefix.length)
}
export function openProjectTerminal(path: string) {
  const host = localStorage.getItem('terminal:sshHost') ?? ''
  if (!host) {
    void dialog.alert({ title: 'Set up iTerm2', message: 'Set SSH host in Settings → iTerm2 on this Mac, and install the updated AgentDeck Finder helper on your MacBook.' })
    return
  }
  window.location.href = `agentdeck-finder://terminal?host=${encodeURIComponent(host)}&path=${encodeURIComponent(path)}`
}
export function FinderSettings() {
  const [value, setValue] = useState(mapping)
  const [saved, setSaved] = useState(false)
  const [sshHost, setSshHost] = useState(() => localStorage.getItem('terminal:sshHost') ?? '')
  const [sshSaved, setSshSaved] = useState(false)
  return <section className={styles.settings}>
    <h2>Finder on this Mac</h2>
    <p>Map a Mac Mini folder to its mounted path. Saved in this browser only. Install AgentDeck Finder on your MacBook first.</p>
    <label className={manage.field}>Mac Mini folder<input className={manage.input} value={value.remote} onChange={(e) => { setValue({ ...value, remote: e.target.value }); setSaved(false) }} placeholder="/Users/aka" /></label>
    <label className={manage.field}>Mounted folder on this Mac<input className={manage.input} value={value.local} onChange={(e) => { setValue({ ...value, local: e.target.value }); setSaved(false) }} placeholder="/Volumes/Your share" /></label>
    <button className={manage.secondary} onClick={() => {
      if (!value.remote.startsWith('/') || (value.local && !value.local.startsWith('/'))) { void dialog.alert({ title: 'Invalid mapping', message: 'Use absolute paths starting with /.' }); return }
      localStorage.setItem(mappingKey, JSON.stringify({ remote: value.remote.trim(), local: value.local.trim() })); setSaved(true)
    }}>Save Finder mapping</button>
    {saved && <span> Saved</span>}
    <p>Setup: <code>scripts/install-finder-helper.sh</code> — run on your MacBook. Clear the mounted folder to disable.</p>
    <h2>iTerm2 on this Mac</h2>
    <p>Connect to the project on Mac Mini over SSH. Uses your MacBook SSH config and keys, without Finder path mapping.</p>
    <label className={manage.field}>SSH host<input className={manage.input} value={sshHost} placeholder="mac-mini" autoCapitalize="none" spellCheck={false} onChange={(e) => { setSshHost(e.target.value); setSshSaved(false) }} /></label>
    <p>Use a host alias from ~/.ssh/config or user@hostname. Configure ports and keys in SSH config.</p>
    <button className={manage.secondary} onClick={() => {
      const host = sshHost.trim()
      if (host && !/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(host)) { void dialog.alert({ title: 'Invalid SSH host', message: 'Enter a host alias or user@hostname, without spaces or command options.' }); return }
      localStorage.setItem('terminal:sshHost', host); setSshHost(host); setSshSaved(true)
    }}>Save SSH host</button>
    {sshSaved && <span> Saved</span>}
  </section>
}
export function FilePreviewHost() {
  const current = useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => selected)
  if (!current) return null
  return <Preview key={`${current.sessionId}:${current.path}:${current.line}`} {...current} />
}
function Preview({ sessionId, path, line }: { sessionId: string; path: string; line?: number }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [source, setSource] = useState(false)
  const [zoom, setZoom] = useState(false)
  const [imageError, setImageError] = useState(false)
  const q = useQuery({ queryKey: ['output', sessionId, path], queryFn: () => api.outputFile(sessionId, path), staleTime: 0, retry: false })
  useEffect(() => { ref.current!.showModal() }, [])
  useEffect(() => { if (q.data && line) ref.current?.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: 'center' }) }, [q.data, line])
  const close = () => { selected = null; listeners.forEach((l) => l()) }
  const file = q.data
  const local = file && mappedPath(file.path)
  const url = api.outputUrl(sessionId, path)
  const relativeToFile = (target: string) => target.startsWith('/') || target.startsWith('~/') ? target : `${file!.path.slice(0, file!.path.lastIndexOf('/') + 1)}${target}`
  return <dialog ref={ref} className={`${modal.dialog} ${styles.preview}`} onClose={close} onClick={(e) => { if (e.target === ref.current) ref.current.close() }} aria-label="File preview">
    <header className={modal.head}><strong className={modal.title}>{file?.name ?? 'File'}</strong><button className={modal.close} onClick={() => ref.current!.close()} aria-label="Close">×</button></header>
    <div className={styles.content}>
      <p className={styles.path}>{file?.path ?? path}</p>
      {q.error && <p role="alert">{q.error.message}</p>}
      {!file && !q.error && <p>Loading…</p>}
      {file && <>
        <p>{file.kind === 'directory' ? 'Folder' : `${file.size.toLocaleString()} bytes · Current file on Mac Mini`}</p>
        {file.kind === 'image' && <><button onClick={() => setZoom(!zoom)} className={modal.secondary}>{zoom ? 'Fit image' : 'Actual size'}</button>{imageError ? <p>Image preview unavailable. Use Finder or download the file.</p> : <div className={styles.image}><img style={zoom ? { maxWidth: 'none', maxHeight: 'none' } : undefined} src={url} alt={file.name} onError={() => setImageError(true)} /></div>}</>}
        {file.kind === 'pdf' && <><p>If the PDF does not display, use Finder or download it.</p><object className={styles.pdf} data={url} type="application/pdf"><p>PDF preview is unavailable on this device.</p></object></>}
        {file.kind === 'audio' && <audio controls src={url} />}
        {file.kind === 'video' && <video className={styles.video} controls src={url} />}
        {file.kind === 'markdown' && <button className={modal.secondary} onClick={() => setSource(!source)}>{source ? 'Preview' : 'Source'}</button>}
        {file.content !== null && <>
          {file.kind === 'markdown' && !source ? <div className={styles.markdown}><Markdown remarkPlugins={[remarkGfm]} urlTransform={(value) => fileReference(value) ? value : defaultUrlTransform(value)} components={{ img: ({ src, alt }) => { const f = fileReference(src ?? ''); return <img src={f ? api.outputUrl(sessionId, relativeToFile(f.path)) : src} alt={alt} loading="lazy" /> }, a: ({ href, children }) => <a href={href} onClick={(e) => { const f = fileReference(href ?? ''); if (f) { e.preventDefault(); showFile(sessionId, relativeToFile(f.path), f.line) } }} target="_blank" rel="noreferrer">{children}</a> }}>{file.content}</Markdown></div> : <pre className={styles.code}>{file.content.split('\n').map((text, i) => <div key={i} data-line={i + 1} data-selected={line === i + 1 || undefined}><span>{i + 1}</span>{text || ' '}</div>)}</pre>}
          {file.truncated && <p>Showing the first 512 KB. Download for the complete file.</p>}
          <button className={modal.secondary} onClick={() => navigator.clipboard.writeText(file.content!)}>Copy text</button>
        </>}
        {file.kind === 'binary' && <p>No inline preview for this file. Open its location in Finder or download a copy.</p>}
        {!local && <p>Configure Finder mapping in Settings to browse this file on your Mac.</p>}
        {local && <p className={styles.path}>On this Mac: {local}</p>}
      </>}
    </div>
    {file && <footer className={modal.actions}>
      {local && <a className={`${modal.primary} ${styles.action}`} onClick={() => ref.current!.close()} href={`agentdeck-finder://reveal?path=${encodeURIComponent(local)}`}>Show in Finder</a>}
      {file.kind !== 'directory' && <a className={`${modal.secondary} ${styles.action}`} onClick={() => ref.current!.close()} href={api.outputUrl(sessionId, path, true)} download={file.name}>Download to this device</a>}
    </footer>}
  </dialog>
}
