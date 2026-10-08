import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { Check, Copy } from 'lucide-react'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, type OutputFile } from '../api'
import { dialog } from './Dialog'
import { PreviewCode } from './PreviewCode'
import styles from './FilePreview.module.css'
import modal from './Dialog.module.css'

type Selected = { sessionId: string; path: string; line?: number; image?: { url: string; name: string } }
let selected: Selected | null = null
const listeners = new Set<() => void>()
export function showFile(sessionId: string, path: string, line?: number) {
  selected = { sessionId, path, line }
  listeners.forEach((l) => l())
}
// 不属于会话输出目录的图片（聊天附件、待发送草稿）：直接给 URL，不走 output 接口
export function showImage(url: string, name: string) {
  selected = { sessionId: '', path: url, image: { url, name } }
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
function Preview({ sessionId, path, line, image }: Selected) {
  const ref = useRef<HTMLDialogElement>(null)
  const [source, setSource] = useState(false)
  // null = fit to the preview; otherwise a multiple of the image's natural size
  const [scale, setScale] = useState<number | null>(null)
  const [natural, setNatural] = useState(0)
  const [imageError, setImageError] = useState(false)
  const [copied, setCopied] = useState(false)
  const imageRef = useRef<HTMLImageElement>(null)
  const q = useQuery({ queryKey: ['output', sessionId, path], queryFn: () => api.outputFile(sessionId, path), staleTime: 0, retry: false, enabled: !image })
  useEffect(() => { ref.current!.showModal() }, [])
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  useEffect(() => { if (q.data && line) ref.current?.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: 'center' }) }, [q.data, line])
  // Keeps the point under (x, y) in place; flushSync so the next pinch event measures the new size
  const zoomTo = (next: number | null, x?: number, y?: number) => {
    const img = imageRef.current!
    const box = img.parentElement!
    const view = box.getBoundingClientRect()
    x ??= view.left + view.width / 2
    y ??= view.top + view.height / 2
    const before = img.getBoundingClientRect()
    flushSync(() => setScale(next === null ? null : Math.min(10, Math.max(0.1, next))))
    const after = img.getBoundingClientRect()
    box.scrollLeft += after.left + (x - before.left) / before.width * after.width - x
    box.scrollTop += after.top + (y - before.top) / before.height * after.height - y
  }
  const currentScale = () => imageRef.current!.getBoundingClientRect().width / imageRef.current!.naturalWidth
  useEffect(() => {
    const box = imageRef.current?.parentElement
    if (!natural || !box) return
    // Trackpad pinch arrives as ctrl+wheel in Chrome / Firefox and as gesture events in Safari
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      zoomTo(currentScale() * Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) / 100), e.clientX, e.clientY)
    }
    let start = 1
    const gestureStart = (e: Event) => { e.preventDefault(); start = currentScale() }
    const gestureChange = (e: Event) => {
      e.preventDefault()
      const g = e as Event & { scale: number; clientX: number; clientY: number }
      zoomTo(start * g.scale, g.clientX, g.clientY)
    }
    box.addEventListener('wheel', wheel, { passive: false })
    box.addEventListener('gesturestart', gestureStart)
    box.addEventListener('gesturechange', gestureChange)
    return () => {
      box.removeEventListener('wheel', wheel)
      box.removeEventListener('gesturestart', gestureStart)
      box.removeEventListener('gesturechange', gestureChange)
    }
  }, [natural])
  const close = () => { selected = null; listeners.forEach((l) => l()) }
  const file: OutputFile | undefined = image ? { path: image.name, name: image.name, size: 0, mime: '', kind: 'image', content: null, truncated: false } : q.data
  const local = file && !image && mappedPath(file.path)
  const url = image?.url ?? api.outputUrl(sessionId, path)
  const relativeToFile = (target: string) => target.startsWith('/') || target.startsWith('~/') ? target : `${file!.path.slice(0, file!.path.lastIndexOf('/') + 1)}${target}`
  return <dialog ref={ref} className={`${modal.dialog} ${styles.preview}`} onClose={close} onClick={(e) => { if (e.target === ref.current) ref.current.close() }} aria-label="File preview">
    <header className={modal.head}>
      <strong className={`${modal.title} ${styles.fileTitle}`} title={file?.path ?? path}>{file?.name ?? 'File'}</strong>
      {file?.kind === 'markdown' && <button className={`${modal.secondary} ${styles.viewButton}`} onClick={() => setSource(!source)}>{source ? 'Preview' : 'Source'}</button>}
      {file?.kind === 'image' && natural > 0 && <>
        <button className={`${modal.secondary} ${styles.viewButton}`} onClick={() => zoomTo(currentScale() / 1.25)} aria-label="Zoom out">−</button>
        <button className={`${modal.secondary} ${styles.viewButton}`} onClick={() => zoomTo(null)} title="Fit image">{scale === null ? 'Fit' : `${Math.round(scale * 100)}%`}</button>
        <button className={`${modal.secondary} ${styles.viewButton}`} onClick={() => zoomTo(currentScale() * 1.25)} aria-label="Zoom in">+</button>
      </>}
      <button className={modal.close} onClick={() => ref.current!.close()} aria-label="Close">×</button>
    </header>
    {!image && <div className={styles.filePath}>{file?.path ?? path}</div>}
    <div className={styles.content}>
      {q.error && <p role="alert">{q.error.message}</p>}
      {!file && !q.error && <p>Loading…</p>}
      {file && <>
        {file.kind === 'image' && <>{imageError ? <p>Image preview unavailable. Use Finder or download the file.</p> : <div className={styles.image}><img ref={imageRef} style={scale === null ? undefined : { width: natural * scale, maxWidth: 'none', maxHeight: 'none' }} src={url} alt={file.name} onLoad={(e) => setNatural(e.currentTarget.naturalWidth)} onDoubleClick={(e) => zoomTo(scale === null ? 1 : null, e.clientX, e.clientY)} onError={() => setImageError(true)} /></div>}</>}
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
      {file.content !== null && <button className={`${modal.secondary} ${styles.copyButton}`} onClick={() => { void navigator.clipboard.writeText(file.content!).then(() => setCopied(true)) }}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy text'}</button>}
      {local && <a className={`${modal.primary} ${styles.action}`} onClick={() => ref.current!.close()} href={`agentdeck-finder://reveal?path=${encodeURIComponent(local)}`}>Show in Finder</a>}
      {file.kind !== 'directory' && <a className={`${modal.secondary} ${styles.action}`} onClick={() => ref.current!.close()} href={image?.url ?? api.outputUrl(sessionId, path, true)} download={file.name}>Download to this device</a>}
    </footer>}
  </dialog>
}
