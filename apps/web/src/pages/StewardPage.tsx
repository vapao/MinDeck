import { useEffect, useMemo, useRef, useState, type UIEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react'
import type { ProviderId, Resolution, StewardResponse } from '@mindeck/shared'
import { api } from '../api'
import { formatEffort, formatModel, providerName } from '../format'
import { navigate } from '../router'
import { useSessionStream, type StreamItem } from '../session/useSessionStream'
import { groupTools, layout, type Entry } from '../session/layout'
import { useMediaQuery } from '../session/useMediaQuery'
import { useAutoHideScrollbar } from '../session/useAutoHideScrollbar'
import { AssistantMessage } from '../components/AssistantMessage'
import { UserMessage } from '../components/UserMessage'
import { ToolGroup } from '../components/ToolCard'
import { ProcessBlock } from '../components/ProcessBlock'
import { ErrorCard } from '../components/ErrorCard'
import { TurnRow, WorkingRow } from '../components/TurnRow'
import { ApprovalCard } from '../components/ApprovalCard'
import { QuestionCard } from '../components/QuestionCard'
import { Composer } from '../components/Composer'
import { Select } from '../components/Select'
import { TabBar } from '../components/TabBar'
import { Loading } from '../components/Loading'
import { useResizable } from '../components/Resizer'
import { dialog } from '../components/Dialog'
import manage from './Manage.module.css'
import styles from './StewardPage.module.css'

// 管家工作台（docs/features.md「管家 Steward」）：左边简报和记忆，右边和管家的对话。
// 对话底层会换会话，页面始终跟最近一个；之前的从对话头部的下拉里进普通会话页

const seenKey = 'steward:seenBrief'
export const useSteward = () => useQuery({ queryKey: ['steward'], queryFn: api.steward, refetchInterval: 10_000 })
/** 侧栏圆点：有还没在页面上看过的新简报 */
export const hasUnseenBrief = (data: StewardResponse | undefined) => !!data?.briefs[0] && data.briefs[0].id !== localStorage.getItem(seenKey)

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

type Tab = 'brief' | 'memory' | 'chat'

export function StewardPage() {
  const desktop = useMediaQuery('(min-width: 1024px)')
  const queryClient = useQueryClient()
  const steward = useSteward()
  const data = steward.data
  const [tab, setTab] = useState<Tab>('brief')
  const { width, handle } = useResizable('steward-chat', 480, 360, 760, 'right')
  const runBrief = useMutation({
    mutationFn: api.stewardBrief,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['steward'] }),
    onError: (err) => dialog.alert({ title: 'Could not run the brief', message: err.message }),
  })
  const current = data?.sessions.find((s) => s.id === data.sessionId)
  const working = current?.status === 'running' || current?.status === 'waiting_user'
  const chat = <ChatPanel data={data} onSent={() => queryClient.invalidateQueries({ queryKey: ['steward'] })} />
  const tabs: [Tab, string][] = [['brief', 'Brief'], ['memory', `Memory${data?.memories.length ? ` ${data.memories.length}` : ''}`], ...(desktop ? [] : [['chat', 'Chat'] as [Tab, string]])]

  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <span className={styles.title}>Steward</span>
        {data && <span className={styles.meta}>Next brief {when(data.nextAutoBriefAt)}</span>}
        <button type="button" className={`${manage.secondary} ${styles.action}`} disabled={!data || runBrief.isPending || working} onClick={() => runBrief.mutate()} title={working ? 'The steward is busy; try again when it finishes' : 'Ask the steward for a brief now'}>
          <Sparkles size={14} /> Run brief
        </button>
      </header>
      <div className={styles.body}>
        <section className={styles.left}>
          <nav className={styles.tabs}>
            {tabs.map(([key, label]) => (
              <button key={key} type="button" className={styles.tab} data-on={tab === key || undefined} onClick={() => setTab(key)}>{label}</button>
            ))}
          </nav>
          {!data ? <Loading label="Loading…" /> : tab === 'brief' ? <BriefView data={data} working={working} /> : tab === 'memory' ? <MemoryView data={data} /> : chat}
        </section>
        {desktop && (
          <section className={styles.chat} style={{ width }}>
            <div {...handle} />
            {chat}
          </section>
        )}
      </div>
      {!desktop && <TabBar />}
    </div>
  )
}

function BriefView({ data, working }: { data: StewardResponse; working: boolean }) {
  const [index, setIndex] = useState(0)
  const brief = data.briefs[index]
  // 新简报到达时回到最新一份
  const latest = data.briefs[0]?.id
  useEffect(() => setIndex(0), [latest])
  useEffect(() => {
    if (latest) localStorage.setItem(seenKey, latest)
  }, [latest])
  const scroll = useRef<HTMLDivElement>(null)
  useAutoHideScrollbar(scroll)
  const failed = data.lastAutoBrief?.error
  return (
    <div ref={scroll} className={styles.scroll}>
      <div className={styles.briefColumn}>
        {failed && index === 0 && <ErrorCard message={`The scheduled brief on ${data.lastAutoBrief!.date} failed: ${failed}`} />}
        {working && index === 0 && <div className={styles.note}>The steward is working. A new brief shows up here when it is published.</div>}
        {brief ? (
          <>
            <div className={styles.briefHead}>
              <span className={styles.briefDate}>{when(brief.createdAt)}</span>
              {index > 0 && <span className={styles.older}>Older brief</span>}
              <span className={styles.spacer} />
              <button type="button" className={styles.iconButton} disabled={index >= data.briefs.length - 1} onClick={() => setIndex(index + 1)} aria-label="Older brief" title="Older brief">
                <ChevronLeft size={16} />
              </button>
              <button type="button" className={styles.iconButton} disabled={index === 0} onClick={() => setIndex(index - 1)} aria-label="Newer brief" title="Newer brief">
                <ChevronRight size={16} />
              </button>
            </div>
            <AssistantMessage text={brief.body} streaming={false} sessionId={brief.sessionId} />
          </>
        ) : (
          <div className={manage.empty}>No brief yet. The steward writes one every weekday at the time set in Settings, or use Run brief.</div>
        )}
      </div>
    </div>
  )
}

function MemoryView({ data }: { data: StewardResponse }) {
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['steward'] })
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const add = useMutation({ mutationFn: api.createMemory, onSuccess: () => { setDraft(''); refresh() } })
  const save = useMutation({ mutationFn: ({ id, text }: { id: string; text: string }) => api.updateMemory(id, text), onSuccess: () => { setEditing(null); refresh() } })
  const remove = useMutation({ mutationFn: api.deleteMemory, onSuccess: refresh })
  const onDelete = async (id: string, text: string) => {
    if (await dialog.confirm({ title: 'Forget this?', message: text, ok: 'Forget', danger: true })) remove.mutate(id)
  }
  const error = add.error ?? save.error ?? remove.error
  return (
    <div className={styles.scroll}>
      <div className={styles.briefColumn}>
        <p className={styles.note}>What the steward keeps across conversations: your preferences, rules and goals. It adds items when you state one; you can change them here and it sees the change on your next message.</p>
        {data.memories.length === 0 && <div className={manage.empty}>Nothing yet.</div>}
        <ul className={styles.memories}>
          {data.memories.map((m) => (
            <li key={m.id} className={styles.memory}>
              {editing?.id === m.id ? (
                <form className={styles.memoryForm} onSubmit={(e) => { e.preventDefault(); save.mutate(editing) }}>
                  <input className={manage.input} value={editing.text} autoFocus onChange={(e) => setEditing({ ...editing, text: e.target.value })} onKeyDown={(e) => e.key === 'Escape' && setEditing(null)} />
                  <button type="submit" className={manage.primary} disabled={!editing.text.trim() || save.isPending}>Save</button>
                  <button type="button" className={manage.secondary} onClick={() => setEditing(null)}>Cancel</button>
                </form>
              ) : (
                <>
                  <span className={styles.memoryText}>{m.text}</span>
                  <button type="button" className={manage.rowButton} onClick={() => setEditing({ id: m.id, text: m.text })} aria-label="Edit" title="Edit"><Pencil size={14} /></button>
                  <button type="button" className={manage.rowButton} data-danger onClick={() => onDelete(m.id, m.text)} aria-label="Forget" title="Forget"><Trash2 size={14} /></button>
                </>
              )}
            </li>
          ))}
        </ul>
        <form className={styles.memoryForm} onSubmit={(e) => { e.preventDefault(); add.mutate(draft) }}>
          <input className={manage.input} value={draft} placeholder="Add something the steward should always keep in mind" onChange={(e) => setDraft(e.target.value)} />
          <button type="submit" className={`${manage.primary} ${styles.action}`} disabled={!draft.trim() || add.isPending}><Plus size={14} /> Add</button>
        </form>
        {error && <div className={manage.error}>{error.message}</div>}
      </div>
    </div>
  )
}

function ChatPanel({ data, onSent }: { data: StewardResponse | undefined; onSent: () => void }) {
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.getSettings })
  const config = settings.data?.steward
  const label = config ? [providerName[config.provider], formatModel(config.provider, config.model || null), formatEffort(config.provider, config.effort || null)].filter(Boolean).join(' · ') : ''
  const earlier = data?.sessions.slice(1) ?? []
  return (
    <div className={styles.chatInner}>
      <div className={styles.chatHead}>
        <span className={styles.chatTitle}>Conversation</span>
        <span className={styles.meta}>{label}</span>
        <span className={styles.spacer} />
        {earlier.length > 0 && (
          <Select ariaLabel="Earlier conversations" value="" placeholder="Earlier" options={earlier.map((s) => ({ value: s.id, label: s.title ?? when(s.createdAt) }))} onChange={(id) => navigate(`/s/${id}`)} />
        )}
      </div>
      {data?.sessionId ? <LiveChat key={data.sessionId} sessionId={data.sessionId} onSent={onSent} /> : <ChatComposer sessionId={null} provider={config?.provider ?? 'codex'} running={false} disabled={!data} onSent={onSent} />}
    </div>
  )
}

function ChatComposer({ sessionId, provider, running, disabled, onSent, onSend }: { sessionId: string | null; provider: ProviderId; running: boolean; disabled: boolean; onSent: () => void; onSend?: () => void }) {
  const send = useMutation({ mutationFn: (text: string) => api.stewardMessage({ text }), onSuccess: onSent })
  const interrupt = useMutation({ mutationFn: () => api.interrupt(sessionId!) })
  const error = send.error ?? interrupt.error
  return (
    <footer className={styles.footer}>
      {send.error && <ErrorCard message={`Send failed. Your message is still in the input box.\n${send.error.message}`} />}
      <Composer
        draftKey="steward"
        disabled={disabled}
        sending={send.isPending}
        running={running}
        interrupting={interrupt.isPending}
        onInterrupt={() => interrupt.mutate()}
        provider={provider}
        imagesAllowed={false}
        meta=""
        hint={interrupt.error ? interrupt.error.message : ''}
        hintError={!!error}
        placeholder="Ask the steward · Enter to send"
        upload={() => Promise.reject(new Error('Images are not supported here'))}
        search={(q) => (sessionId ? api.listEntries(sessionId, q) : Promise.resolve({ entries: [] }))}
        listSkills={() => (sessionId ? api.listSkills(sessionId) : Promise.resolve({ skills: [] }))}
        onSend={(text) => {
          onSend?.()
          return send.mutateAsync(text).then(() => true, () => false)
        }}
      />
    </footer>
  )
}

function LiveChat({ sessionId, onSent }: { sessionId: string; onSent: () => void }) {
  const { status, items, connection, turnStartedAt, session } = useSessionStream(sessionId)
  const running = status === 'running' || status === 'waiting_user'
  const stream = useRef<HTMLDivElement>(null)
  const column = useRef<HTMLDivElement>(null)
  useAutoHideScrollbar(stream)
  // 跟随底部，用户上翻后停止跟随，回到底部附近恢复（同会话页）
  const follow = useRef(true)
  const anchor = useRef(0)
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) follow.current = true
    else if (el.scrollTop < anchor.current) follow.current = false
    anchor.current = el.scrollTop
  }
  useEffect(() => {
    const el = stream.current!
    const observer = new ResizeObserver(() => {
      if (!follow.current) return
      el.scrollTop = el.scrollHeight
      anchor.current = el.scrollTop
    })
    observer.observe(el)
    observer.observe(column.current!)
    return () => observer.disconnect()
  }, [])
  const [opened, setOpened] = useState<Set<string>>(() => new Set())
  const entries = useMemo(() => layout(items), [items])
  const resolve = useMutation({ mutationFn: ({ id, body }: { id: string; body: Resolution }) => api.resolvePending(id, body) })
  const pendingProps = (id: string) => ({
    busy: resolve.isPending && resolve.variables?.id === id,
    error: resolve.error && resolve.variables?.id === id ? resolve.error.message : null,
  })
  const renderItem = (it: StreamItem) => {
    switch (it.kind) {
      case 'user':
        return <UserMessage key={it.key} text={it.text} attachments={it.attachments} at={it.at} />
      case 'assistant':
        return <AssistantMessage key={it.key} sessionId={sessionId} text={it.text} streaming={it.streaming} />
      case 'error':
        return <ErrorCard key={it.key} message={it.message} />
      case 'turn':
        return <TurnRow key={it.key} reason={it.reason} durationMs={it.durationMs} at={it.at} />
      case 'approval':
        return <ApprovalCard key={it.key} request={it.request} cwd={session?.cwd ?? ''} state={it.state} decision={it.decision} resolvedAt={it.resolvedAt} {...pendingProps(it.request.id)}
          onResolve={(decision) => resolve.mutate({ id: it.request.id, body: { kind: 'approval', decision } })} />
      case 'question':
        return <QuestionCard key={it.key} request={it.request} provider={session?.provider ?? 'codex'} state={it.state} answers={it.answers} response={it.response} resolvedAt={it.resolvedAt} {...pendingProps(it.request.id)}
          onSubmit={(answers, response) => resolve.mutate({ id: it.request.id, body: { kind: 'question', answers, response } })} />
    }
  }
  const renderEntries = (list: Entry[]) =>
    list.map((e) => {
      switch (e.kind) {
        case 'tools':
          return <ToolGroup key={e.key} items={e.items} />
        case 'process':
          return (
            <ProcessBlock key={e.key} steps={e.steps} tools={e.tools} open={opened.has(e.key)} onToggle={() => {
              follow.current = false
              setOpened((s) => {
                const next = new Set(s)
                if (next.has(e.key)) next.delete(e.key)
                else next.add(e.key)
                return next
              })
            }}>
              {renderEntries(groupTools(e.items))}
            </ProcessBlock>
          )
        default:
          return renderItem(e)
      }
    })
  return (
    <>
      <div ref={stream} className={styles.stream} onScroll={onScroll}>
        <div ref={column} className={styles.streamColumn}>
          {connection !== 'open' && entries.length === 0 && <Loading label="Loading conversation…" />}
          {renderEntries(entries)}
          {turnStartedAt && running && <WorkingRow since={turnStartedAt} />}
        </div>
      </div>
      <ChatComposer sessionId={sessionId} provider={session?.provider ?? 'codex'} running={running} disabled={status === 'waiting_user' || connection !== 'open'} onSent={onSent} onSend={() => { follow.current = true }} />
    </>
  )
}
