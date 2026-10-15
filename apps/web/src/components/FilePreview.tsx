import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy } from 'lucide-react'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, type OutputFile } from '../api'
import { dialog } from './Dialog'
import { PreviewCode } from './PreviewCode'
import { CodeDiff, CodeView } from './CodeView'
import styles from './FilePreview.module.css'
import modal from './Dialog.module.css'

// discard 存在表示从 Changes 打开：默认显示 diff，底部提供丢弃改动；返回 true 表示已丢弃
type Selected = { sessionId: string; path: string; line?: number; image?: { url: string; name: string }; discard?: (path: string) => Promise<boolean> }
let selected: Selected | null = null
const listeners = new Set<() => void>()
export function showFile(sessionId: string, path: string, line?: number) {
  selected = { sessionId, path, line }
  listeners.forEach((l) => l())
}
export function showDiff(sessionId: string, path: string, discard: (path: string) => Promise<boolean>) {
  selected = { sessionId, path, discard }
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
  return <Preview key={`${current.sessionId}:${current.path}:${current.line}:${!!current.discard}`} {...current} />
}
function Preview({ sessionId, path, line, image, discard }: Selected) {
  const ref = useRef<HTMLDialogElement>(null)
  const [mode, setMode] = useState<'diff' | 'file'>(discard ? 'diff' : 'file')
  const [source, setSource] = useState(false)
  // null = fit to the preview; otherwise a multiple of the image's natural size
  const [scale, setScale] = useState<number | null>(null)
  const [natural, setNatural] = useState(0)
  const [imageError, setImageError] = useState(false)
  const [copied, setCopied] = useState(false)
  const imageRef = useRef<HTMLImageElement>(null)
  // null = viewing; otherwise the unsaved editor text
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const client = useQueryClient()
  const q = useQuery({ queryKey: ['output', sessionId, path], queryFn: () => api.outputFile(sessionId, path), staleTime: 0, retry: false, enabled: !image })
  useEffect(() => { ref.current!.showModal() }, [])
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])
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
  const dirty = draft !== null && draft !== q.data?.content?.replace(/\r\n/g, '\n')
  const confirmDiscard = async () => !dirty || await dialog.confirm({ title: 'Discard unsaved changes?', message: 'Your edits to this file will be lost.', ok: 'Discard', danger: true }) === true
  const requestClose = async () => { if (await confirmDiscard()) ref.current!.close() }
  const save = async () => {
    if (!dirty || saving) return
    setSaving(true)
    try {
      // 编辑器内统一为 LF，按原文件换行写回，避免整份文件出现在 diff 里。
      const content = q.data!.content!.includes('\r\n') ? draft!.replace(/\n/g, '\r\n') : draft!
      await api.saveProjectFile(sessionId, { path: q.data!.path, content })
      await Promise.all(['projectFiles', 'changes', 'diff', 'file', 'output'].map((key) => client.invalidateQueries({ queryKey: [key] })))
      setDraft(null)
    } catch (err) {
      await dialog.alert({ title: 'Could not save file', message: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }
  const file: OutputFile | undefined = image ? { path: image.name, name: image.name, size: 0, mime: '', kind: 'image', content: null, truncated: false } : q.data
  const local = file && !image && mappedPath(file.path)
  const url = image?.url ?? api.outputUrl(sessionId, path)
  const relativeToFile = (target: string) => target.startsWith('/') || target.startsWith('~/') ? target : `${file!.path.slice(0, file!.path.lastIndexOf('/') + 1)}${target}`
  return <dialog ref={ref} className={`${modal.dialog} ${styles.preview}`} onClose={close} onCancel={(e) => { if (dirty) { e.preventDefault(); void requestClose() } }} onClick={(e) => { if (e.target === ref.current) void requestClose() }} aria-label="File preview">
    <header className={modal.head}>
      <strong className={`${modal.title} ${styles.fileTitle}`} title={file?.path ?? path}>{file?.name ?? (discard ? path.split('/').pop() : 'File')}</strong>
      {discard && draft === null && <button className={`${modal.secondary} ${styles.viewButton}`} onClick={() => setMode(mode === 'diff' ? 'file' : 'diff')}>{mode === 'diff' ? 'File' : 'Diff'}</button>}
      {mode === 'file' && file?.editable && draft === null && <button className={`${modal.secondary} ${styles.viewButton}`} onClick={() => setDraft(file.content!.replace(/\r\n/g, '\n'))}>Edit</button>}
      {mode === 'file' && file?.kind === 'markdown' && draft === null && <button className={`${modal.secondary} ${styles.viewButton}`} onClick={() => setSource(!source)}>{source ? 'Preview' : 'Source'}</button>}
      {file?.kind === 'image' && natural > 0 && <>
        <button className={`${modal.secondary} ${styles.viewButton}`} onClick={() => zoomTo(currentScale() / 1.25)} aria-label="Zoom out">−</button>
        <button className={`${modal.secondary} ${styles.viewButton}`} onClick={() => zoomTo(null)} title="Fit image">{scale === null ? 'Fit' : `${Math.round(scale * 100)}%`}</button>
        <button className={`${modal.secondary} ${styles.viewButton}`} onClick={() => zoomTo(currentScale() * 1.25)} aria-label="Zoom in">+</button>
      </>}
      <button className={modal.close} onClick={() => void requestClose()} aria-label="Close">×</button>
    </header>
    {!image && <div className={styles.filePath}>{file?.path ?? path}</div>}
    {mode === 'diff' && <>
      <div className={styles.content}><DiffBody sessionId={sessionId} path={path} /></div>
      <footer className={`${modal.actions} ${styles.footer}`}>
        <button className={modal.primary} data-danger onClick={() => { void discard!(path).then((done) => { if (done) ref.current?.close() }) }}>Discard changes</button>
      </footer>
    </>}
    {mode === 'file' && <><div className={styles.content}>
      {q.error && <p role="alert">{q.error.message}</p>}
      {!file && !q.error && <p>Loading…</p>}
      {file && <>
        {file.kind === 'image' && <>{imageError ? <p>Image preview unavailable. Use Finder or download the file.</p> : <div className={styles.image}><img ref={imageRef} style={scale === null ? undefined : { width: natural * scale, maxWidth: 'none', maxHeight: 'none' }} src={url} alt={file.name} onLoad={(e) => setNatural(e.currentTarget.naturalWidth)} onDoubleClick={(e) => zoomTo(scale === null ? 1 : null, e.clientX, e.clientY)} onError={() => setImageError(true)} /></div>}</>}
        {file.kind === 'pdf' && <><object className={styles.pdf} data={url} type="application/pdf"><p>PDF preview is unavailable on this device.</p></object></>}
        {file.kind === 'audio' && <audio controls src={url} />}
        {file.kind === 'video' && <video className={styles.video} controls src={url} />}
        {file.content !== null && <>
          {file.kind === 'markdown' && !source && draft === null ? <div className={styles.markdown}><Markdown remarkPlugins={[remarkGfm]} urlTransform={(value) => fileReference(value) ? value : defaultUrlTransform(value)} components={{ code: ({ className, children }) => {
            const language = /language-([^\s]+)/.exec(className ?? '')?.[1]
            return language ? <PreviewCode text={String(children)} language={language} /> : <code className={className}>{children}</code>
          }, img: ({ src, alt }) => { const f = fileReference(src ?? ''); return <img src={f ? api.outputUrl(sessionId, relativeToFile(f.path)) : src} alt={alt} loading="lazy" /> }, a: ({ href, children }) => <a href={href} onClick={(e) => { const f = fileReference(href ?? ''); if (f) { e.preventDefault(); showFile(sessionId, relativeToFile(f.path), f.line) } }} target="_blank" rel="noreferrer">{children}</a> }}>{file.content}</Markdown></div> : <CodeView className={styles.code} text={file.content.replace(/\r\n/g, '\n')} path={file.name} line={line} editable={draft !== null} onChange={setDraft} onSave={() => void save()} />}
          {file.truncated && <p>Showing the first 512 KB. Download for the complete file.</p>}
        </>}
        {file.kind === 'binary' && <p>No inline preview for this file. Open its location in Finder or download a copy.</p>}
      </>}
    </div>
    {file && draft !== null && <footer className={`${modal.actions} ${styles.footer}`}>
      <button className={modal.secondary} onClick={() => { void confirmDiscard().then((ok) => { if (ok) setDraft(null) }) }}>Cancel</button>
      <button className={modal.primary} onClick={() => void save()} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save'}</button>
    </footer>}
    {file && draft === null && <footer className={`${modal.actions} ${styles.footer}`}>
      {file.content !== null && <button className={`${modal.secondary} ${styles.copyButton}`} onClick={() => { void navigator.clipboard.writeText(file.content!).then(() => setCopied(true)) }}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy text'}</button>}
      {local && <a className={`${modal.primary} ${styles.action}`} onClick={() => ref.current!.close()} href={`agentdeck-finder://reveal?path=${encodeURIComponent(local)}`}>Show in Finder</a>}
      {file.kind !== 'directory' && <a className={`${modal.secondary} ${styles.action}`} onClick={() => ref.current!.close()} href={image?.url ?? api.outputUrl(sessionId, path, true)} download={file.name}>Download to this device</a>}
    </footer>}
    </>}
  </dialog>
}

function DiffBody({ sessionId, path }: { sessionId: string; path: string }) {
  const q = useQuery({ queryKey: ['diff', sessionId, path], queryFn: () => api.fileDiff(sessionId, path), staleTime: 0, retry: false })
  if (q.error) return <p role="alert">{q.error.message}</p>
  if (!q.data) return <p>Loading…</p>
  if (q.data.binary) return <p>Binary file; no inline diff.</p>
  if (q.data.tooLarge) return <p>File too large to diff (over 512 KB).</p>
  if (q.data.original === q.data.current) return <p>No differences</p>
  return <CodeDiff className={styles.code} original={q.data.original} current={q.data.current} path={path} />
}
