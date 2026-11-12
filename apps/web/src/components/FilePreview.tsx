import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from 'react'
import { flushSync } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronLeft, ChevronRight, Copy, Download } from 'lucide-react'
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
let state: { selected: Selected | null } = { selected: null }
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
  const current = state.selected
  if (current && previewKey(current) === previewKey(next)) return
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
function mapping() { return JSON.parse(localStorage.getItem(mappingKey) ?? '{"remote":"","local":""}') as { remote: string; local: string } }
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
    void dialog.alert({ title: 'Set up Finder', message: 'Configure this project’s folder mapping in Settings → Finder on this Mac, and install the MinDeck Finder helper on your MacBook.' })
    return
  }
  window.location.href = `mindeck-finder://reveal?path=${encodeURIComponent(local)}`
}
export function openProjectTerminal(path: string) {
  const host = localStorage.getItem('terminal:sshHost') ?? ''
  if (!host) {
    void dialog.alert({ title: 'Set up iTerm2', message: 'Set SSH host in Settings → iTerm2 on this Mac, and install the updated MinDeck Finder helper on your MacBook.' })
    return
  }
  window.location.href = `mindeck-finder://terminal?host=${encodeURIComponent(host)}&path=${encodeURIComponent(path)}`
}
export function FilePreviewHost() {
  const { selected } = usePreviewState()
  return selected && <Preview key={previewKey(selected)} {...selected} />
}
type ImageNavigation = { index: number; count: number; step: (offset: number) => void }
function Preview({ sessionId, path, line, image, discard, onDismiss, navigation }: Selected & { onDismiss?: () => void; navigation?: ImageNavigation }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [mode, setMode] = useState<'diff' | 'file'>(discard ? 'diff' : 'file')
  const [source, setSource] = useState(!!line)
  const [gallery, setGallery] = useState<{ images: NonNullable<Selected['image']>[]; index: number } | null>(null)
  // null = fit to the preview; otherwise a multiple of the image's natural size
  const [scale, setScale] = useState<number | null>(null)
  const [natural, setNatural] = useState(0)
  const [imageError, setImageError] = useState(false)
  const [copied, setCopied] = useState(false)
  const imageRef = useRef<HTMLImageElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null)
  const dragged = useRef(false)
  const endDrag = () => { drag.current = null; setDragging(false) }
  const pan = {
    onPointerDown(e: PointerEvent<HTMLDivElement>) {
      if (e.pointerType !== 'mouse' || e.button !== 0 || e.target !== imageRef.current) return
      dragged.current = false
      const box = e.currentTarget
      if (box.scrollWidth <= box.clientWidth && box.scrollHeight <= box.clientHeight) return
      e.preventDefault()
      imageRef.current!.setPointerCapture(e.pointerId)
      drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, left: box.scrollLeft, top: box.scrollTop }
      setDragging(true)
    },
    onPointerMove(e: PointerEvent<HTMLDivElement>) {
      const start = drag.current
      if (!start || start.id !== e.pointerId) return
      const dx = e.clientX - start.x, dy = e.clientY - start.y
      if (Math.abs(dx) + Math.abs(dy) > 4) dragged.current = true
      e.currentTarget.scrollLeft = start.left - dx
      e.currentTarget.scrollTop = start.top - dy
    },
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onLostPointerCapture: endDrag,
  }
  // 可编辑文件直接可输入：null = 没有未保存改动；否则是编辑器文本。
  // base 是开始改动时读到的磁盘内容，保存时交给服务端做冲突检查
  const [draft, setDraft] = useState<string | null>(null)
  const base = useRef('')
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
    if (x === undefined || y === undefined || x < view.left || x > view.right || y < view.top || y > view.bottom) {
      x = view.left + box.clientWidth / 2
      y = view.top + box.clientHeight / 2
    }
    const before = img.getBoundingClientRect()
    flushSync(() => setScale(next === null ? null : Math.min(10, Math.max(0.1, next))))
    const after = img.getBoundingClientRect()
    box.scrollLeft += after.left + (x - before.left) / before.width * after.width - x
    box.scrollTop += after.top + (y - before.top) / before.height * after.height - y
  }
  const currentScale = () => imageRef.current!.getBoundingClientRect().width / imageRef.current!.naturalWidth
  const latest = useRef({ scale, navigation })
  useLayoutEffect(() => { latest.current = { scale, navigation } })
  useEffect(() => {
    const surface = imageRef.current?.closest('dialog')
    if (!natural || !surface) return
    // Trackpad pinch arrives as ctrl+wheel in Chrome / Firefox and as gesture events in Safari
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      zoomTo(currentScale() * Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) / 100), e.clientX, e.clientY)
    }
    let start = 1
    // iOS 触屏双指同时发 touch 与 gesture 事件，缩放由下面的 touch 处理；gesture 只负责 Mac 触控板
    let touches = 0
    const gestureStart = (e: Event) => { e.preventDefault(); start = currentScale() }
    const gestureChange = (e: Event) => {
      e.preventDefault()
      if (touches) return
      const g = e as Event & { scale: number; clientX: number; clientY: number }
      zoomTo(start * g.scale, g.clientX, g.clientY)
    }
    const gestureEnd = (e: Event) => e.preventDefault()
    // 手机：双指缩放只作用于图片（以双指中点为基点，中点移动时同时平移）；单指交给原生滚动平移，
    // 图片未超出视口时左右滑切换，双击在适应视口与原尺寸间切换
    const box = imageRef.current!.parentElement!
    let pinch: { distance: number; scale: number; x: number; y: number } | null = null
    let swipe: { x: number; y: number } | null = null
    let lastTap = { time: 0, x: 0, y: 0 }
    const spread = (t: TouchList) => ({ distance: Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY), x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 })
    const touchStart = (e: TouchEvent) => {
      touches = e.touches.length
      if (touches >= 2) {
        e.preventDefault()
        swipe = null
        pinch = { ...spread(e.touches), scale: currentScale() }
      } else if (box.contains(e.target as Node)) {
        swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      }
    }
    const touchMove = (e: TouchEvent) => {
      if (e.touches.length < 2 || !pinch) return
      e.preventDefault()
      const now = spread(e.touches)
      box.scrollLeft -= now.x - pinch.x
      box.scrollTop -= now.y - pinch.y
      pinch.x = now.x
      pinch.y = now.y
      zoomTo(pinch.scale * now.distance / pinch.distance, now.x, now.y)
    }
    const touchEnd = (e: TouchEvent) => {
      touches = e.touches.length
      if (touches) return
      if (pinch) {
        pinch = null
        // 缩到比视口还小时回到适应视口，避免图片缩成一角
        const img = imageRef.current!
        if (img.offsetWidth <= box.clientWidth && img.offsetHeight <= box.clientHeight) zoomTo(null)
        return
      }
      if (!swipe) return
      const { clientX: x, clientY: y } = e.changedTouches[0]
      const dx = x - swipe.x, dy = y - swipe.y
      swipe = null
      const nav = latest.current.navigation
      if (nav && box.scrollWidth <= box.clientWidth && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        nav.step(dx < 0 ? 1 : -1)
        return
      }
      if (Math.abs(dx) + Math.abs(dy) > 10 || e.target !== imageRef.current) return
      if (e.timeStamp - lastTap.time < 300 && Math.abs(x - lastTap.x) + Math.abs(y - lastTap.y) < 30) {
        // 阻止随后合成的 dblclick，避免与桌面双击处理重复切换
        e.preventDefault()
        lastTap.time = 0
        zoomTo(latest.current.scale === null ? 1 : null, x, y)
      } else {
        lastTap = { time: e.timeStamp, x, y }
      }
    }
    // 包括工具栏与遮罩，避免指针离开图片时缩放整页；不拦截普通滚动。
    surface.addEventListener('wheel', wheel as EventListener, { passive: false, capture: true })
    surface.addEventListener('gesturestart', gestureStart, { passive: false, capture: true })
    surface.addEventListener('gesturechange', gestureChange, { passive: false, capture: true })
    surface.addEventListener('gestureend', gestureEnd, { passive: false, capture: true })
    surface.addEventListener('touchstart', touchStart, { passive: false, capture: true })
    surface.addEventListener('touchmove', touchMove, { passive: false, capture: true })
    surface.addEventListener('touchend', touchEnd, { passive: false, capture: true })
    surface.addEventListener('touchcancel', touchEnd, { passive: false, capture: true })
    return () => {
      surface.removeEventListener('wheel', wheel as EventListener, true)
      surface.removeEventListener('gesturestart', gestureStart, true)
      surface.removeEventListener('gesturechange', gestureChange, true)
      surface.removeEventListener('gestureend', gestureEnd, true)
      surface.removeEventListener('touchstart', touchStart, true)
      surface.removeEventListener('touchmove', touchMove, true)
      surface.removeEventListener('touchend', touchEnd, true)
      surface.removeEventListener('touchcancel', touchEnd, true)
    }
  }, [natural, mode, imageError])
  const dismiss = () => ref.current!.close()
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
    if (onDismiss) return
    confirmLeave = () => leave.current()
    return () => { confirmLeave = null }
  }, [onDismiss])
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
  const html = file?.kind === 'text' && /\.html?$/i.test(file.name)
  const htmlUrl = html ? api.previewUrl(sessionId, file!.path) : undefined
  const local = file && !image && mappedPath(file.path)
  const url = image?.url ?? api.outputUrl(sessionId, path)
  const relativeToFile = (target: string) => target.startsWith('/') || target.startsWith('~/') ? target : `${file!.path.slice(0, file!.path.lastIndexOf('/') + 1)}${target}`
  const bindHtmlImages = (frame: HTMLIFrameElement) => {
    const doc = frame.contentDocument
    if (!doc) return
    const isImageLink = (link: HTMLAnchorElement) => /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i.test(new URL(link.href).pathname)
    const imageUrl = (img: HTMLImageElement) => {
      const link = img.closest<HTMLAnchorElement>('a[href]')
      return link && isImageLink(link) ? link.href : img.currentSrc || img.src
    }
    // 接管图片链接的默认新窗口行为，报告本身和滚动位置留在下面。
    doc.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.defaultPrevented) return
      const target = event.target as Element
      const link = target.closest<HTMLAnchorElement>('a[href]')
      const img = target.closest<HTMLImageElement>('img')
      if (link ? !isImageLink(link) : !img || img.closest('button, [role="button"]')) return
      const url = link ? link.href : imageUrl(img!)
      const images = [...doc.images]
        .filter((item) => !item.closest('button, [role="button"]') && (!item.closest('a[href]') || isImageLink(item.closest<HTMLAnchorElement>('a[href]')!)))
        .map((item) => ({ url: imageUrl(item), name: item.alt || 'Image' }))
        .filter((item, index, items) => item.url && items.findIndex((other) => other.url === item.url) === index)
      let index = images.findIndex((item) => item.url === url)
      if (index < 0) index = images.push({ url, name: link?.textContent?.trim() || 'Image' }) - 1
      event.preventDefault()
      event.stopPropagation()
      setGallery({ images, index })
    }, true)
  }
  const fullPath = file?.path ?? path
  const body = <>
    <header className={modal.head}>
      <strong className={`${modal.title} ${styles.fileTitle}`}>{!image && <span className={styles.fileDir}>{fullPath.slice(0, fullPath.lastIndexOf('/') + 1)}</span>}{file?.name ?? fullPath.slice(fullPath.lastIndexOf('/') + 1)}</strong>
      {navigation && navigation.count > 1 && <div className={styles.imageNavigation}>
        <button className={`${modal.secondary} ${styles.viewButton}`} disabled={navigation.index === 0} onClick={() => navigation.step(-1)} aria-label="Previous image" title="Previous image (←)"><ChevronLeft size={16} /></button>
        <span aria-live="polite">{navigation.index + 1} / {navigation.count}</span>
        <button className={`${modal.secondary} ${styles.viewButton}`} disabled={navigation.index === navigation.count - 1} onClick={() => navigation.step(1)} aria-label="Next image" title="Next image (→)"><ChevronRight size={16} /></button>
      </div>}
      {discard && !dirty && <button className={`${modal.secondary} ${styles.viewButton}`} onClick={() => setMode(mode === 'diff' ? 'file' : 'diff')}>{mode === 'diff' ? 'File' : 'Diff'}</button>}
      {mode === 'file' && (file?.kind === 'markdown' || html) && !dirty && <button className={`${modal.secondary} ${styles.viewButton}`} onClick={() => setSource(!source)}>{source ? 'Preview' : 'Source'}</button>}
      {file?.kind === 'image' && natural > 0 && <div className={styles.zoomControls}>
        <button className={`${modal.secondary} ${styles.viewButton}`} onClick={() => zoomTo(currentScale() / 1.25)} aria-label="Zoom out">−</button>
        <button className={`${modal.secondary} ${styles.viewButton} ${styles.zoomValue}`} onClick={() => zoomTo(null)} title="Fit image">{scale === null ? 'Fit' : `${Math.round(scale * 100)}%`}</button>
        <button className={`${modal.secondary} ${styles.viewButton}`} onClick={() => zoomTo(currentScale() * 1.25)} aria-label="Zoom in">+</button>
      </div>}
      {file?.kind === 'image' && <a className={`${modal.close} ${styles.headerDownload}`} href={image?.url ?? api.outputUrl(sessionId, path, true)} download={file.name} aria-label="Download"><Download size={18} /></a>}
      <button className={modal.close} onClick={() => void requestClose()} aria-label="Close">×</button>
    </header>
    {mode === 'diff' && <>
      <div className={styles.content}><DiffBody sessionId={sessionId} path={path} /></div>
      <footer className={`${modal.actions} ${styles.footer}`}>
        <button className={modal.primary} data-danger onClick={() => { void discard!(path).then((done) => { if (done) dismiss() }) }}>Discard changes</button>
      </footer>
    </>}
    {mode === 'file' && <><div className={`${styles.content} ${file?.kind === 'image' ? styles.imageContent : ''}`} onClick={(e) => { if (navigation && e.target === e.currentTarget) dismiss() }}>
      {q.error && <p role="alert">{q.error.message}</p>}
      {!file && !q.error && <p>Loading…</p>}
      {file && <>
        {file.kind === 'image' && <>{imageError ? <p>Image preview unavailable. Use Finder or download the file.</p> : <div className={styles.image} {...pan} data-dragging={dragging || undefined} onClickCapture={(e) => { if (dragged.current) { dragged.current = false; e.preventDefault(); e.stopPropagation() } }} onClick={(e) => { if (navigation && e.target === e.currentTarget) dismiss() }}><img ref={imageRef} draggable={false} style={scale === null ? undefined : { width: natural * scale, maxWidth: 'none', maxHeight: 'none' }} src={url} alt={file.name} onLoad={(e) => setNatural(e.currentTarget.naturalWidth)} onDoubleClick={(e) => zoomTo(scale === null ? 1 : null, e.clientX, e.clientY)} onError={() => setImageError(true)} /></div>}</>}
        {file.kind === 'pdf' && <><object className={styles.pdf} data={url} type="application/pdf"><p>PDF preview is unavailable on this device.</p></object></>}
        {file.kind === 'audio' && <audio controls src={url} />}
        {file.kind === 'video' && <video className={styles.video} controls src={url} />}
        {html && !source && !dirty && <iframe ref={frameRef} key={q.dataUpdatedAt} className={styles.html} src={htmlUrl} title={file.name} onLoad={(e) => bindHtmlImages(e.currentTarget)} />}
        {file.content !== null && (!html || source || dirty) && <>
          {file.kind === 'markdown' && !source && !dirty ? <div className={styles.markdown}><Markdown remarkPlugins={[remarkGfm]} urlTransform={(value) => fileReference(value) ? value : defaultUrlTransform(value)} components={{ code: ({ className, children }) => {
            const language = /language-([^\s]+)/.exec(className ?? '')?.[1]
            return language ? <PreviewCode text={String(children)} language={language} /> : <code className={className}>{children}</code>
          }, table: ({ node: _, ...props }) => <div className={styles.table}><table {...props} /></div>, img: ({ src, alt }) => { const f = fileReference(src ?? ''); return <img src={f ? api.outputUrl(sessionId, relativeToFile(f.path)) : src} alt={alt} loading="lazy" /> }, a: ({ href, children }) => <a href={href} onClick={(e) => { const f = fileReference(href ?? ''); if (f) { e.preventDefault(); showFile(sessionId, relativeToFile(f.path), f.line) } }} target="_blank" rel="noreferrer">{children}</a> }}>{file.content}</Markdown></div> : <CodeView className={styles.code} text={content!} path={file.name} line={line} editable={!!file.editable} dirty={dirty} onChange={edit} onSave={() => void save()} />}
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
      {html && <a className={`${modal.secondary} ${styles.action}`} href={htmlUrl} target="_blank" rel="noreferrer">Open in new tab</a>}
      {file.content !== null && <button className={`${modal.secondary} ${styles.copyButton}`} onClick={() => { void navigator.clipboard.writeText(file.content!).then(() => setCopied(true)) }}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy text'}</button>}
      {local && <a className={`${modal.primary} ${styles.action}`} onClick={dismiss} href={`mindeck-finder://reveal?path=${encodeURIComponent(local)}`}>Show in Finder</a>}
      {file.kind !== 'directory' && <a className={`${modal.secondary} ${styles.action}`} onClick={dismiss} href={image?.url ?? api.outputUrl(sessionId, path, true)} download={file.name}>Download</a>}
    </footer>}
    </>}
  </>
  const preview = <dialog ref={ref} className={`${modal.dialog} ${styles.preview} ${mode === 'file' && file?.kind === 'image' ? styles.imagePreview : ''}`} onClose={() => onDismiss ? onDismiss() : update({ selected: null })} onCancel={(e) => { if (dirty) { e.preventDefault(); void requestClose() } }} onClick={(e) => { if (e.target === ref.current) void requestClose() }} onKeyDown={(e) => {
      if (!navigation || e.altKey || e.ctrlKey || e.metaKey || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return
      e.preventDefault()
      navigation.step(e.key === 'ArrowLeft' ? -1 : 1)
    }} aria-label={navigation ? 'Image preview' : 'File preview'}>{body}</dialog>
  return <>{preview}{gallery && <Preview key={gallery.images[gallery.index].url} sessionId="" path={gallery.images[gallery.index].url} image={gallery.images[gallery.index]} onDismiss={() => {
    setGallery(null)
    // Android Chrome：图片弹窗 showModal 期间报告 iframe 为 inert，关闭后 iframe 的滚动命中区域不刷新，滑动落到外层页面（下拉触发整页刷新）。
    // 等图片弹窗从 DOM 移除后把 iframe 隐藏两帧再恢复，迫使重建；在 close 当下做或只隐藏一帧，真机验证均无效
    setTimeout(() => {
      const frame = frameRef.current
      if (!frame) return
      frame.style.visibility = 'hidden'
      requestAnimationFrame(() => requestAnimationFrame(() => { frame.style.visibility = '' }))
    })
  }} navigation={{
    index: gallery.index, count: gallery.images.length,
    step: (offset) => setGallery((current) => current && ({ ...current, index: Math.max(0, Math.min(current.images.length - 1, current.index + offset)) })),
  }} />}</>
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
