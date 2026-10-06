import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowUp, ChevronUp, File, Folder, FolderOpen, ImagePlus, MessageSquare, MessageSquarePlus, Sparkles, Square, SquareTerminal, X } from 'lucide-react'
import { getEffortOptions, modelOptions, type Attachment, skillToken, type EntriesResponse, type ProviderId, type Session, type SkillsResponse } from '@agentdeck/shared'
import { api } from '../api'
import { Select } from './Select'
import { showImage } from './FilePreview'
import { providerName } from '../format'
import { readDraft, saveDraft } from '../session/drafts'
import { splitRefs } from '../refs'
import styles from './Composer.module.css'

type Props = {
  /** 草稿按此 key 存 localStorage，切走再切回来输入内容还在 */
  draftKey: string
  disabled: boolean
  /** 一轮进行中：发送按钮换成中断；Enter 仍可发送，作为追加指令排队 */
  running: boolean
  interrupting: boolean
  onInterrupt: () => void
  /** "新开一轮"（等价 /clear）；未就绪时不传，按钮置灰 */
  onFresh?: () => void
  onTerminal?: () => void
  onFinder?: () => void
  provider: ProviderId
  imagesAllowed?: boolean
  /** 空会话可以换 Agent：传了就把 Provider 名字渲染成三选一下拉 */
  onSwitchProvider?: (provider: ProviderId) => void
  /** 空会话可以换模型 / 思考等级：传了就在 Provider 后面渲染下拉；空字符串 = Provider 默认 */
  modelSelect?: { model: string; effort: string; onChange: (model: string, effort: string) => void }
  /** 状态区 Provider 名字后面的会话信息（模型、思考等级、上下文用量） */
  meta: string
  /** 需要用户注意的状态（排队、等待、报错）；为空时状态区只显示 meta */
  hint: string
  hintError?: boolean
  placeholder: string
  upload: (file: File) => Promise<Attachment>
  /** @ 引用补全：q 是 @ 后面敲的内容 */
  search: (q: string) => Promise<EntriesResponse>
  /** $ 补全：当前会话 Provider 可用的 skill */
  listSkills: () => Promise<SkillsResponse>
  onSend: (text: string, attachmentIds: string[]) => void
}

type Mention = { kind: '@' | '$' | '#'; start: number; query: string }

// $ 只在消息开头触发 skill；@ 文件和 # 会话引用从行首或空白后开始，遇到空白结束补全
function mentionAt(text: string, caret: number): Mention | null {
  const before = text.slice(0, caret)
  if (/^\$\S*$/.test(before)) return { kind: '$', start: 0, query: before.slice(1) }
  const match = before.match(/(?:^|\s)([@#])(\S*)$/)
  return match ? { kind: match[1] as '@' | '#', start: before.length - match[2].length - 1, query: match[2] } : null
}

// 选中即上传，发送时只引用服务端返回的 attachmentId（方案 §9.1）
type Draft = { key: string; file: File; previewUrl: string } & ({ status: 'uploading' } | { status: 'done'; id: string } | { status: 'error'; message: string })

const maxPerMessage = 5

export function Composer({ draftKey, disabled, running, interrupting, onInterrupt, onFresh, onTerminal, onFinder, provider, imagesAllowed = true, onSwitchProvider, modelSelect, meta, hint, hintError, placeholder, upload, search, listSkills, onSend }: Props) {
  const [text, setText] = useState(() => readDraft(draftKey))
  useEffect(() => {
    saveDraft(draftKey, text)
  }, [draftKey, text])
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)

  // 空会话的 Agent / 模型 / 思考等级平时只显示成一段文字，点开才在输入框上方弹出下拉，不占输入区
  const switchable = onSwitchProvider !== undefined && drafts.length === 0
  const [switching, setSwitching] = useState(false)
  const switcher = useRef<HTMLDivElement>(null)
  const switchButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!switching) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!switcher.current?.contains(t) && !switchButton.current?.contains(t)) setSwitching(false)
    }
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setSwitching(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [switching])

  // @ 补全：光标位置变化时重新判定；选中目录后保持打开继续往里敲
  const [mention, setMention] = useState<Mention | null>(null)
  const [cursor, setCursor] = useState(0)
  const mentionList = useRef<HTMLDivElement>(null)
  // 键盘上下选项时把选中项滚进可视区
  useEffect(() => {
    mentionList.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])
  const entries = useQuery({
    queryKey: ['entries', draftKey, mention?.query ?? ''],
    queryFn: () => search(mention!.query),
    enabled: mention?.kind === '@',
    placeholderData: (prev) => prev,
  })
  // 列表要起进程扫描（Claude 约 2 秒），按会话 + Provider 缓存；空会话换 Provider 后重新拉
  const token = skillToken(text)
  const skills = useQuery({ queryKey: ['skills', draftKey, provider], queryFn: listSkills, enabled: mention?.kind === '$' || token !== undefined, staleTime: 60_000 })
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.listSessions, enabled: mention?.kind === '#' })
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: api.listWorkspaces, enabled: mention?.kind === '#' })
  const workspaceName = (cwd: string) => workspaces.data?.find((w) => w.path === cwd)?.alias ?? cwd.split('/').pop() ?? cwd
  const currentCwd = sessions.data?.find((s) => s.id === draftKey)?.cwd
  const sessionOptions = mention?.kind === '#' ? (sessions.data ?? [])
    .filter((s) => s.id !== draftKey && `${s.title ?? 'New session'} ${workspaceName(s.cwd)} ${s.cwd} ${s.id} ${providerName[s.provider]}`.toLowerCase().includes(mention.query.toLowerCase()))
    .sort((a, b) => Number(b.cwd === currentCwd) - Number(a.cwd === currentCwd)) : []
  const skillName = token !== undefined && skills.data?.skills.some((s) => s.name === token) ? token : null
  const segments = splitRefs(text, skillName)
  const highlighted = segments.some((s) => s.kind !== 'text')
  const backdrop = useRef<HTMLDivElement>(null)
  const options = mention?.kind === '@' ? (entries.data?.entries ?? []) : []
  const skillOptions = mention?.kind === '$' ? (skills.data?.skills ?? []).filter((s) => s.name.toLowerCase().includes(mention.query.toLowerCase())) : []
  const optionCount = mention?.kind === '$' ? skillOptions.length : mention?.kind === '#' ? sessionOptions.length : options.length
  const selectedIndex = Math.min(cursor, Math.max(0, optionCount - 1))
  const syncMention = () => {
    const el = textarea.current
    if (!el) return
    setMention(mentionAt(el.value, el.selectionStart))
    setCursor(0)
  }
  const pick = (opt: EntriesResponse['entries'][number]) => {
    const el = textarea.current
    if (!el || !mention) return
    const insert = `@${opt.path}${opt.dir ? '' : ' '}`
    const next = text.slice(0, mention.start) + insert + text.slice(el.selectionStart)
    const caret = mention.start + insert.length
    setText(next)
    // 等 React 写回 value 后再放光标；目录保持弹层继续浏览
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(caret, caret)
      setMention(opt.dir ? { kind: '@', start: mention.start, query: opt.path } : null)
      setCursor(0)
    })
  }
  const pickSkill = (skill: SkillsResponse['skills'][number]) => {
    const el = textarea.current
    if (!el) return
    const insert = `$${skill.name} `
    setText(insert + text.slice(el.selectionStart))
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(insert.length, insert.length)
      setMention(null)
    })
  }
  const pickSession = (session: Session) => {
    const el = textarea.current
    if (!el || !mention) return
    const title = (session.title ?? 'New session').replace(/[[\]\r\n]/g, ' ')
    const insert = `#[${title}](session:${session.id}) `
    setText(text.slice(0, mention.start) + insert + text.slice(el.selectionStart))
    const caret = mention.start + insert.length
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(caret, caret)
      setMention(null)
    })
  }
  // 卸载时释放所有预览 URL
  const draftsRef = useRef(drafts)
  useEffect(() => {
    draftsRef.current = drafts
  }, [drafts])
  useEffect(() => () => draftsRef.current.forEach((d) => URL.revokeObjectURL(d.previewUrl)), [])

  const patch = (key: string, next: Partial<Draft>) => setDrafts((ds) => ds.map((d) => (d.key === key ? ({ ...d, ...next } as Draft) : d)))

  const addFiles = (files: Iterable<File>) => {
    if (!imagesAllowed) return
    const images = [...files].filter((f) => f.type.startsWith('image/')).slice(0, Math.max(0, maxPerMessage - drafts.length))
    if (images.length === 0) return
    const added: Draft[] = images.map((file) => ({ key: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file), status: 'uploading' }))
    setDrafts((ds) => [...ds, ...added])
    for (const d of added) {
      upload(d.file).then(
        (a) => patch(d.key, { status: 'done', id: a.id }),
        (err: Error) => patch(d.key, { status: 'error', message: err.message }),
      )
    }
  }
  const remove = (key: string) => {
    setDrafts((ds) => {
      const d = ds.find((x) => x.key === key)
      if (d) URL.revokeObjectURL(d.previewUrl)
      return ds.filter((x) => x.key !== key)
    })
  }

  const uploading = drafts.some((d) => d.status === 'uploading')
  const failed = drafts.find((d) => d.status === 'error')
  const ids = drafts.flatMap((d) => (d.status === 'done' ? [d.id] : []))
  const canSend = !disabled && !uploading && !failed && (imagesAllowed || drafts.length === 0) && (text.trim() !== '' || ids.length > 0)
  // 轮次进行中才提示"会排队"，且只在真的写了东西时——空输入框没必要一直挂着
  const queued = running && (text.trim() !== '' || ids.length > 0)

  const submit = () => {
    if (!canSend) return
    onSend(text.trim(), ids)
    drafts.forEach((d) => URL.revokeObjectURL(d.previewUrl))
    setText('')
    setDrafts([])
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (mention && optionCount > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setCursor((c) => (c + (e.key === 'ArrowDown' ? 1 : optionCount - 1)) % optionCount)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        if (mention.kind === '$') pickSkill(skillOptions[selectedIndex])
        else if (mention.kind === '#') pickSession(sessionOptions[selectedIndex])
        else pick(options[selectedIndex])
        return
      }
    }
    if (mention && e.key === 'Escape') {
      setMention(null)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (e.clipboardData.files.length === 0) return
    e.preventDefault()
    addFiles(e.clipboardData.files)
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    addFiles(e.dataTransfer.files)
  }

  return (
    <div className={styles.wrap}>
      {drafts.length > 0 && (
        <div className={styles.chips}>
          {drafts.map((d) => (
            <div key={d.key} className={styles.chip} data-status={d.status} title={d.status === 'error' ? d.message : d.file.name}>
              <button type="button" className={styles.chipOpen} onClick={() => showImage(d.previewUrl, d.file.name)} aria-label={`Preview ${d.file.name}`}>
                <img className={styles.chipThumb} src={d.previewUrl} alt="" />
                <code className={styles.chipName}>{d.file.name}</code>
              </button>
              <span className={styles.chipMeta}>{d.status === 'uploading' ? 'Uploading…' : d.status === 'error' ? 'Upload failed' : formatSize(d.file.size)}</span>
              <button type="button" className={styles.chipRemove} onClick={() => remove(d.key)} aria-label="Remove">
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className={styles.boxWrap}>
        {switchable && switching && (
          <div ref={switcher} className={styles.switcher}>
            <div className={styles.switchField}>
              Agent
              <Select ariaLabel="Agent" value={provider} onChange={(p) => onSwitchProvider(p as ProviderId)} options={(Object.keys(providerName) as ProviderId[]).map((p) => ({ value: p, label: providerName[p] }))} />
            </div>
            {modelSelect && (
              <>
                <div className={styles.switchField}>
                  Model
                  <Select ariaLabel="Model" value={modelSelect.model} onChange={(m) => modelSelect.onChange(m, modelSelect.effort)} options={[{ value: '', label: 'Default' }, ...modelOptions[provider]]} />
                </div>
                {provider !== 'deepseek' && (
                  <div className={styles.switchField}>
                    Effort
                    <Select ariaLabel="Effort" value={modelSelect.effort} onChange={(e) => modelSelect.onChange(modelSelect.model, e)} options={[{ value: '', label: 'Default' }, ...getEffortOptions(provider, modelSelect.model || null)]} />
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {mention?.kind === '$' && (
          <div ref={mentionList} className={styles.mentions}>
            {skillOptions.length === 0 ? (
              <div className={styles.mentionEmpty}>{skills.isFetching ? '…' : skills.isError ? skills.error.message : 'No matching skills'}</div>
            ) : (
              skillOptions.map((skill, i) => (
                <button
                  key={skill.name}
                  type="button"
                  className={styles.mention}
                  data-active={i === selectedIndex || undefined}
                  title={skill.description}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickSkill(skill)}
                  onMouseEnter={() => setCursor(i)}
                >
                  <Sparkles size={14} />
                  <code className={styles.mentionName}>{skill.name}</code>
                  <span className={styles.mentionDesc}>{skill.description}</span>
                </button>
              ))
            )}
          </div>
        )}
        {mention?.kind === '#' && (
          <div ref={mentionList} className={styles.mentions}>
            {sessionOptions.length === 0 ? (
              <div className={styles.mentionEmpty}>{sessions.isFetching ? '…' : sessions.isError ? sessions.error.message : 'No matching sessions'}</div>
            ) : sessionOptions.map((session, i) => (
              <button
                key={session.id}
                type="button"
                className={`${styles.mention} ${styles.sessionMention}`}
                data-active={i === selectedIndex || undefined}
                title={`${session.title ?? 'New session'} · ${session.cwd} · ${session.id}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickSession(session)}
                onMouseEnter={() => setCursor(i)}
              >
                <MessageSquare size={14} />
                <span className={styles.mentionPath}>{session.title ?? 'New session'}</span>
                <span className={styles.mentionDesc}>{workspaceName(session.cwd)} · {providerName[session.provider]} · {session.id.slice(0, 8)}{session.archivedAt ? ' · Inactive' : ''}</span>
              </button>
            ))}
          </div>
        )}
        {mention?.kind === '@' && (
          <div ref={mentionList} className={styles.mentions}>
            {options.length === 0 ? (
              <div className={styles.mentionEmpty}>{entries.isFetching ? '…' : 'No matches'}</div>
            ) : (
              options.map((opt, i) => (
                <button
                  key={opt.path}
                  type="button"
                  className={styles.mention}
                  data-active={i === selectedIndex || undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(opt)}
                  onMouseEnter={() => setCursor(i)}
                >
                  {opt.dir ? <Folder size={14} /> : <File size={14} />}
                  <code className={styles.mentionPath}>{opt.path}</code>
                </button>
              ))
            )}
          </div>
        )}
        <div
          className={styles.box}
          data-dragging={dragging || undefined}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <div className={styles.field}>
            {/* textarea 没法给部分文字上色：背后垫一层同排版的文字代为显示，$skill、@ 文件和 # 会话引用单独着色 */}
            {highlighted && (
              <div ref={backdrop} className={styles.backdrop} aria-hidden>
                {segments.map((s, i) => (s.kind === 'text' ? s.text : <mark key={i} className={s.kind === 'skill' ? styles.skillMark : styles.fileMark}>{s.text}</mark>))}
              </div>
            )}
            <textarea
              ref={textarea}
              className={styles.input}
              data-highlight={highlighted || undefined}
              rows={1}
              value={text}
              placeholder={placeholder}
              onChange={(e) => {
                setText(e.target.value)
                syncMention()
              }}
              onKeyDown={onKeyDown}
              onKeyUp={(e) => {
                // 上下键在弹层里选项，不动光标；左右 / Home / End 会移动光标，重新判定 @ / $ 位置
                if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') syncMention()
              }}
              onClick={syncMention}
              onScroll={(e) => backdrop.current && (backdrop.current.scrollTop = e.currentTarget.scrollTop)}
              onBlur={() => setMention(null)}
              onPaste={onPaste}
            />
          </div>
          <div className={styles.bar}>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files)
                e.target.value = ''
              }}
            />
            <button type="button" className={styles.attach} onClick={() => fileInput.current?.click()} disabled={!imagesAllowed || drafts.length >= maxPerMessage} aria-label="Add image" title={imagesAllowed ? "Add image" : "DeepSeek Pro 不支持图片"}>
              <ImagePlus size={16} />
            </button>
            {switchable ? (
              <button ref={switchButton} type="button" className={styles.provider} onClick={() => setSwitching((v) => !v)} aria-expanded={switching} title="Change agent, model or effort">
                {[providerName[provider], meta].filter(Boolean).join(' · ')}
                <ChevronUp size={14} />
              </button>
            ) : (
              <>
                <span className={styles.provider}>{providerName[provider]}</span>
                <span className={styles.meta}>{meta}</span>
              </>
            )}
            {(failed || uploading || hint || queued) && (
              <span className={styles.hint} data-error={(failed || hintError) || undefined} data-queue={(!failed && !uploading && !hint && queued) || undefined}>
                {failed ? failed.message : uploading ? 'Uploading images…' : hint || 'A turn is running; your message will be delivered at its next step'}
              </span>
            )}
            {onFinder && <button type="button" className={styles.fresh} onClick={onFinder} aria-label="Open in Finder" title="Open this project folder in Finder"><FolderOpen size={16} /></button>}
            {onTerminal && <button type="button" className={styles.fresh} onClick={onTerminal} aria-label="Open in iTerm2" title="Connect to this project over SSH in iTerm2"><SquareTerminal size={16} /></button>}
            <button type="button" className={styles.fresh} onClick={onFresh} disabled={!onFresh} aria-label="Start fresh" title="Start a new session in the same workspace with a fresh context">
              <MessageSquarePlus size={16} />
            </button>
            {running ? (
              <button type="button" className={styles.stop} onClick={onInterrupt} disabled={interrupting} aria-label="Stop" title="Stop the current turn">
                <Square size={12} />
              </button>
            ) : (
              <button type="button" className={styles.send} onClick={submit} disabled={!canSend} aria-label="Send">
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

const formatSize = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`)
