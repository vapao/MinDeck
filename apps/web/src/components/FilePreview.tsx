import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '../api'
import { dialog } from './Dialog'
import { PreviewCode } from './PreviewCode'
import styles from './FilePreview.module.css'
import modal from './Dialog.module.css'

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
export type LocalSettings = { remote: string; local: string; sshHost: string }
export function readLocalSettings(): LocalSettings { return { ...mapping(), sshHost: localStorage.getItem('terminal:sshHost') ?? '' } }
export function saveLocalSettings(value: LocalSettings) {
  localStorage.setItem(mappingKey, JSON.stringify({ remote: value.remote, local: value.local }))
  localStorage.setItem('terminal:sshHost', value.sshHost)
}
export function mappedPath(path: string) {
  const { remote, local } = mapping()
  const prefix = remote.replace(/\/+$/, '')
  if (!local || !remote || (path !== prefix && !path.startsWith(prefix + '/'))) return null
  return local.replace(/\/+$/, '') + path.slice(prefix.length)
}
export function openProjectFinder(path: string) {
  const local = mappedPath(path)
  if (!local) {
    void dialog.alert({ title: 'Set up Finder', message: 'Configure this project’s folder mapping in Settings → Finder on this Mac, and install the AgentDeck Finder helper on your MacBook.' })
    return
  }
  window.location.href = `agentdeck-finder://reveal?path=${encodeURIComponent(local)}`
}
export function openProjectTerminal(path: string) {
  const host = localStorage.getItem('terminal:sshHost') ?? ''
  if (!host) {
    void dialog.alert({ title: 'Set up iTerm2', message: 'Set SSH host in Settings → iTerm2 on this Mac, and install the updated AgentDeck Finder helper on your MacBook.' })
    return
  }
  window.location.href = `agentdeck-finder://terminal?host=${encodeURIComponent(host)}&path=${encodeURIComponent(path)}`
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
    <header className={modal.head}>
      <strong className={`${modal.title} ${styles.fileTitle}`} title={file?.path ?? path}>{file?.name ?? 'File'}</strong>
      {file?.kind === 'markdown' && <button className={`${modal.secondary} ${styles.viewButton}`} onClick={() => setSource(!source)}>{source ? 'Preview' : 'Source'}</button>}
      {file?.kind === 'image' && <button className={`${modal.secondary} ${styles.viewButton}`} onClick={() => setZoom(!zoom)}>{zoom ? 'Fit image' : 'Actual size'}</button>}
      <button className={modal.close} onClick={() => ref.current!.close()} aria-label="Close">×</button>
    </header>
    <div className={styles.content}>
      {q.error && <p role="alert">{q.error.message}</p>}
      {!file && !q.error && <p>Loading…</p>}
      {file && <>
        {file.kind === 'image' && <>{imageError ? <p>Image preview unavailable. Use Finder or download the file.</p> : <div className={styles.image}><img style={zoom ? { maxWidth: 'none', maxHeight: 'none' } : undefined} src={url} alt={file.name} onError={() => setImageError(true)} /></div>}</>}
        {file.kind === 'pdf' && <><object className={styles.pdf} data={url} type="application/pdf"><p>PDF preview is unavailable on this device.</p></object></>}
        {file.kind === 'audio' && <audio controls src={url} />}
        {file.kind === 'video' && <video className={styles.video} controls src={url} />}
        {file.content !== null && <>
          {file.kind === 'markdown' && !source ? <div className={styles.markdown}><Markdown remarkPlugins={[remarkGfm]} urlTransform={(value) => fileReference(value) ? value : defaultUrlTransform(value)} components={{ code: ({ className, children }) => {
            const language = /language-([^\s]+)/.exec(className ?? '')?.[1]
            return language ? <PreviewCode text={String(children)} language={language} /> : <code className={className}>{children}</code>
          }, img: ({ src, alt }) => { const f = fileReference(src ?? ''); return <img src={f ? api.outputUrl(sessionId, relativeToFile(f.path)) : src} alt={alt} loading="lazy" /> }, a: ({ href, children }) => <a href={href} onClick={(e) => { const f = fileReference(href ?? ''); if (f) { e.preventDefault(); showFile(sessionId, relativeToFile(f.path), f.line) } }} target="_blank" rel="noreferrer">{children}</a> }}>{file.content}</Markdown></div> : <pre className={styles.code}><PreviewCode text={file.content} path={file.name} numbered line={line} /></pre>}
          {file.truncated && <p>Showing the first 512 KB. Download for the complete file.</p>}
        </>}
        {file.kind === 'binary' && <p>No inline preview for this file. Open its location in Finder or download a copy.</p>}
      </>}
    </div>
    {file && <footer className={`${modal.actions} ${styles.footer}`}>
      {file.content !== null && <button className={modal.secondary} onClick={() => navigator.clipboard.writeText(file.content!)}>Copy text</button>}
      {local && <a className={`${modal.primary} ${styles.action}`} onClick={() => ref.current!.close()} href={`agentdeck-finder://reveal?path=${encodeURIComponent(local)}`}>Show in Finder</a>}
      {file.kind !== 'directory' && <a className={`${modal.secondary} ${styles.action}`} onClick={() => ref.current!.close()} href={api.outputUrl(sessionId, path, true)} download={file.name}>Download to this device</a>}
    </footer>}
  </dialog>
}
