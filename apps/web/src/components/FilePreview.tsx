import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy } from 'lucide-react'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, type OutputFile } from '../api'
import { dialog } from './Dialog'
import { PreviewCode } from './PreviewCode'
import { CodeDiff, CodeView } from './CodeView'
import { useResizable } from './Resizer'
import styles from './FilePreview.module.css'
import modal from './Dialog.module.css'

// discard 存在表示从 Changes 打开：默认显示 diff，底部提供丢弃改动；返回 true 表示已丢弃
type Selected = { sessionId: string; path: string; line?: number; image?: { url: string; name: string }; discard?: (path: string) => Promise<boolean> }
// docked：桌面会话页挂着停靠预览栏，此时不再弹窗
let state: { selected: Selected | null; docked: boolean } = { selected: null, docked: false }
const listeners = new Set<() => void>()
function update(next: Partial<typeof state>) {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}
const usePreviewState = () => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => state)
const previewKey = (s: Selected) => `${s.sessionId}:${s.path}:${s.line}:${!!s.discard}`
// 当前预览有未保存的编辑时，切到别的文件前先确认放弃
let confirmLeave: (() => Promise<boolean>) | null = null
async function select(next: Selected) {
  if (state.selected && previewKey(state.selected) === previewKey(next)) return
  if (confirmLeave && !(await confirmLeave())) return
  update({ selected: next })
}
export function showFile(sessionId: string, path: string, line?: number) {
  void select({ sessionId, path, line })
}
export function showDiff(sessionId: string, path: string, discard: (path: string) => Promise<boolean>) {
  void select({ sessionId, path, discard })
}
// 不属于会话输出目录的图片（聊天附件、待发送草稿）：直接给 URL，不走 output 接口
export function showImage(url: string, name: string) {
  void select({ sessionId: '', path: url, image: { url, name } })
}
/** 正在预览的路径，供文件树高亮 */
export function usePreviewPath(sessionId: string) {
  const { selected } = usePreviewState()
  return selected?.sessionId === sessionId ? selected.path : undefined
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
  const { selected, docked } = usePreviewState()
  if (!selected || docked) return null
  return <Preview key={previewKey(selected)} {...selected} />
}
// 桌面会话页：预览停靠在对话与侧栏之间，不挡文件树，点别的文件直接替换内容。
// 离开会话时关闭；version 变化（Agent 改了文件）时重新读取
export function FilePreviewDock({ version }: { version: number }) {
  const { selected } = usePreviewState()
  const { width, handle } = useResizable('preview', 560, 320, 900, 'right')
  useEffect(() => {
    update({ docked: true })
    return () => update({ docked: false, selected: null })
  }, [])
  if (!selected) return null
  return <Preview key={previewKey(selected)} {...selected} dock={{ width, handle }} version={version} />
}
type Dock = { width: number; handle: ReturnType<typeof useResizable>['handle'] }
function Preview({ sessionId, path, line, image, discard, dock, version }: Selected & { dock?: Dock; version?: number }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [mode, setMode] = useState<'diff' | 'file'>(discard ? 'diff' : 'file')
  const [source, setSource] = useState(false)
  // null = fit to the preview; otherwise a multiple of the image's natural size
  const [scale, setScale] = useState<number | null>(null)
  const [natural, setNatural] = useState(0)
  const [imageError, setImageError] = useState(false)
  const [copied, setCopied] = useState(false)
  const imageRef = useRef<HTMLImageElement>(null)
  // 可编辑文件直接可输入：null = 没有未保存改动；否则是编辑器文本。
  // base 是开始改动时读到的磁盘内容，保存时交给服务端做冲突检查
  const [draft, setDraft] = useState<string | null>(null)
  const base = useRef('')
  const [saving, setSaving] = useState(false)
  const client = useQueryClient()
  const q = useQuery({ queryKey: ['output', sessionId, path], queryFn: () => api.outputFile(sessionId, path), staleTime: 0, retry: false, enabled: !image })
  const docked = !!dock
  useEffect(() => { if (!docked) ref.current!.showModal() }, [docked])
  const firstVersion = useRef(version)
  useEffect(() => {
    if (version === firstVersion.current) return
    const timer = setTimeout(() => { for (const key of ['output', 'diff']) void client.invalidateQueries({ queryKey: [key, sessionId, path] }) }, 1500)
    return () => clearTimeout(timer)
  }, [version, client, sessionId, path])
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
  const dismiss = () => dock ? update({ selected: null }) : ref.current!.close()
  const content = q.data?.content?.replace(/\r\n/g, '\n')
  const dirty = draft !== null
  const edit = (value: string) => {
    if (value === content) return setDraft(null)
    if (draft === null) base.current = q.data!.content!
    setDraft(value)
  }
  const confirmDiscard = async () => !dirty || await dialog.confirm({ title: 'Discard unsaved changes?', message: 'Your edits to this file will be lost.', ok: 'Discard', danger: true }) === true
  const leave = useRef(confirmDiscard)
  useLayoutEffect(() => { leave.current = confirmDiscard })
  useEffect(() => {
    confirmLeave = () => leave.current()
    return () => { confirmLeave = null }
  }, [])
  const requestClose = async () => { if (await confirmDiscard()) dismiss() }
  const save = async () => {
    if (draft === null || saving) return
    setSaving(true)
    try {
      // 编辑器内统一为 LF，按原文件换行写回，避免整份文件出现在 diff 里。
      const body = { path: q.data!.path, content: base.current.includes('\r\n') ? draft.replace(/\n/g, '\r\n') : draft }
      try {
        await api.saveProjectFile(sessionId, { ...body, expected: base.current })
      } catch (err) {
        if ((err as { status?: number }).status !== 409) throw err
        if (!await dialog.confirm({ title: 'File changed on disk', message: 'It was modified after you started editing, possibly by the agent. Overwrite it with your version?', ok: 'Overwrite', danger: true })) return
        await api.saveProjectFile(sessionId, body)
      }
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
  const body = <>
    <header className={modal.head}>
      <strong className={`${modal.title} ${styles.fileTitle}`} title={file?.path ?? path}>{file?.name ?? (discard ? path.split('/').pop() : 'File')}</strong>
      {discard && !dirty && <button className={`${modal.secondary} ${styles.viewButton}`} onClick={() => setMode(mode === 'diff' ? 'file' : 'diff')}>{mode === 'diff' ? 'File' : 'Diff'}</button>}
      {mode === 'file' && file?.kind === 'markdown' && !dirty && <button className={`${modal.secondary} ${styles.viewButton}`} onClick={() => setSource(!source)}>{source ? 'Preview' : 'Source'}</button>}
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
        <button className={modal.primary} data-danger onClick={() => { void discard!(path).then((done) => { if (done) dismiss() }) }}>Discard changes</button>
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
          {file.kind === 'markdown' && !source && !dirty ? <div className={styles.markdown}><Markdown remarkPlugins={[remarkGfm]} urlTransform={(value) => fileReference(value) ? value : defaultUrlTransform(value)} components={{ code: ({ className, children }) => {
            const language = /language-([^\s]+)/.exec(className ?? '')?.[1]
            return language ? <PreviewCode text={String(children)} language={language} /> : <code className={className}>{children}</code>
          }, img: ({ src, alt }) => { const f = fileReference(src ?? ''); return <img src={f ? api.outputUrl(sessionId, relativeToFile(f.path)) : src} alt={alt} loading="lazy" /> }, a: ({ href, children }) => <a href={href} onClick={(e) => { const f = fileReference(href ?? ''); if (f) { e.preventDefault(); showFile(sessionId, relativeToFile(f.path), f.line) } }} target="_blank" rel="noreferrer">{children}</a> }}>{file.content}</Markdown></div> : <CodeView className={styles.code} text={content!} path={file.name} line={line} editable={!!file.editable} dirty={dirty} onChange={edit} onSave={() => void save()} />}
          {file.truncated && <p>Showing the first 512 KB. Download for the complete file.</p>}
        </>}
        {file.kind === 'binary' && <p>No inline preview for this file. Open its location in Finder or download a copy.</p>}
      </>}
    </div>
    {file && dirty && <footer className={`${modal.actions} ${styles.footer}`}>
      <button className={modal.secondary} onClick={() => { void confirmDiscard().then((ok) => { if (ok) { setDraft(null); void q.refetch() } }) }}>Cancel</button>
      <button className={modal.primary} onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
    </footer>}
    {file && !dirty && <footer className={`${modal.actions} ${styles.footer}`}>
      {file.content !== null && <button className={`${modal.secondary} ${styles.copyButton}`} onClick={() => { void navigator.clipboard.writeText(file.content!).then(() => setCopied(true)) }}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy text'}</button>}
      {local && <a className={`${modal.primary} ${styles.action}`} onClick={dock ? undefined : dismiss} href={`agentdeck-finder://reveal?path=${encodeURIComponent(local)}`}>Show in Finder</a>}
      {file.kind !== 'directory' && <a className={`${modal.secondary} ${styles.action}`} onClick={dock ? undefined : dismiss} href={image?.url ?? api.outputUrl(sessionId, path, true)} download={file.name}>Download to this device</a>}
    </footer>}
    </>}
  </>
  return dock
    ? <aside className={styles.dock} style={{ width: dock.width }} aria-label="File preview"><div {...dock.handle} />{body}</aside>
    : <dialog ref={ref} className={`${modal.dialog} ${styles.preview}`} onClose={() => update({ selected: null })} onCancel={(e) => { if (dirty) { e.preventDefault(); void requestClose() } }} onClick={(e) => { if (e.target === ref.current) void requestClose() }} aria-label="File preview">{body}</dialog>
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
