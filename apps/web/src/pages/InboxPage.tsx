import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlarmClock, ArrowUpRight, ChevronLeft, CircleHelp, FileText, Hourglass, Inbox, Plus, ShieldAlert } from 'lucide-react'
import type { InboxResponse, PendingRequest, Report, Resolution, Session, Todo, UnfinishedSession } from '@agentdeck/shared'
import { api } from '../api'
import { formatModel } from '../format'
import { navigate, usePathname } from '../router'
import { confirmDeleteSession, useSessions } from '../session/useSessions'
import { useInbox } from '../session/useInbox'
import { useMediaQuery } from '../session/useMediaQuery'
import { useAutoHideScrollbar } from '../session/useAutoHideScrollbar'
import { ApprovalCard } from '../components/ApprovalCard'
import { QuestionCard } from '../components/QuestionCard'
import { AssistantMessage } from '../components/AssistantMessage'
import { Loading } from '../components/Loading'
import { TabBar } from '../components/TabBar'
import { openNewSession } from '../components/NewSessionDialog'
import { localDay, openTodo } from '../components/TodoDialog'
import { formatDay } from './TodosPage'
import styles from './InboxPage.module.css'

type Request = PendingRequest & { resolution?: Resolution | null }
type Item =
  | { key: string; type: 'blocking' | 'decide'; createdAt: string; request: Request }
  | { key: string; type: 'report'; createdAt: string; report: Report }
  | { key: string; type: 'todo'; createdAt: string; todo: Todo }
  | { key: string; type: 'unfinished'; createdAt: string; unfinished: UnfinishedSession }
type Filter = 'all' | 'blocking' | 'decide' | 'report' | 'followup' | 'done'
const followup = (type: Item['type']) => type === 'todo' || type === 'unfinished'

const sections: { type: Item['type']; label: string }[] = [
  { type: 'blocking', label: 'Blocking a running turn' },
  { type: 'decide', label: 'Needs your decision' },
  { type: 'report', label: 'Reports' },
  { type: 'todo', label: 'Reminders' },
  { type: 'unfinished', label: 'Unfinished work' },
]

// 卡着一轮的审批 / 同步提问在前；异步提问（Agent 提交的待决定事项、Codex 非阻塞提问）不卡任何东西。
// 之后是到期的待办，最后是判为没收尾的会话（可能一次冒出很多，放在最后不挤掉别的）
function toItems(data: InboxResponse | undefined): Item[] {
  if (!data) return []
  return [
    ...data.requests.map((request): Item => ({
      key: `request/${request.id}`,
      type: request.kind === 'question' && request.delivery === 'async' ? 'decide' : 'blocking',
      createdAt: request.createdAt,
      request,
    })),
    ...data.reports.map((report): Item => ({ key: `report/${report.id}`, type: 'report', createdAt: report.createdAt, report })),
    ...data.todos.map((todo): Item => ({ key: `todo/${todo.id}`, type: 'todo', createdAt: `${todo.remindOn}T00:00:00`, todo })),
    ...data.unfinished.map((unfinished): Item => ({ key: `unfinished/${unfinished.sessionId}`, type: 'unfinished', createdAt: unfinished.idleSince, unfinished })),
  ]
}

function ago(iso: string) {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (minutes < 60) return `${Math.max(minutes, 1)}m`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`
  return new Date(iso).toLocaleDateString('en-GB', minutes < 7 * 24 * 60 ? { weekday: 'short' } : { day: '2-digit', month: '2-digit' })
}

function headline(item: Item, session?: Session): { kind: string; title: string; line: string } {
  if (item.type === 'report') return { kind: 'Report', title: item.report.title, line: item.report.summary }
  if (item.type === 'todo') return { kind: 'Reminder', title: item.todo.title, line: item.todo.note.split('\n')[0] ?? '' }
  if (item.type === 'unfinished') return { kind: 'Unfinished', title: session?.title ?? 'Session', line: item.unfinished.next }
  const r = item.request
  if (r.kind === 'question') {
    const q = r.questions[0]
    return { kind: item.type === 'decide' ? 'Decide' : 'Answer', title: q?.question ?? 'Question', line: r.details?.trim().split('\n')[0] ?? q?.options.map((o) => o.label).join(' · ') ?? '' }
  }
  const input = r.input as Record<string, unknown>
  const line = typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? input.file_path : ''
  return { kind: 'Approve', title: r.title ?? r.toolName, line }
}

// Inbox（首页 /）：所有需要用户处理的事。桌面左列表右详情；手机列表与详情分两页，详情路由 /inbox/:kind/:id
export function InboxPage() {
  const pathname = usePathname()
  const desktop = useMediaQuery('(min-width: 1024px)')
  const [filter, setFilter] = useState<Filter>('all')
  const inbox = useInbox()
  const done = useQuery({ queryKey: ['inbox', true], queryFn: () => api.inbox(true), enabled: filter === 'done' })
  const sessions = useSessions()
  const list = useRef<HTMLDivElement>(null)
  useAutoHideScrollbar(list)

  const open = toItems(inbox.data)
  const counts = { blocking: 0, decide: 0, report: 0, followup: 0 }
  for (const item of open) counts[followup(item.type) ? 'followup' : (item.type as 'blocking' | 'decide' | 'report')]++
  const shown = filter === 'done'
    ? toItems(done.data).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    : open.filter((item) => filter === 'all' || item.type === filter || (filter === 'followup' && followup(item.type)))
  const ordered = filter === 'done' ? shown : sections.flatMap((s) => shown.filter((item) => item.type === s.type))

  const selectedKey = pathname.match(/^\/inbox\/((?:request|report|todo|unfinished)\/[^/]+)$/)?.[1]
  // 桌面没选时默认看第一条；选中的那条处理掉后从列表消失，顺延到下一条
  const selected = ordered.find((item) => item.key === selectedKey) ?? (desktop ? ordered[0] : undefined)
  const next = () => {
    const i = ordered.findIndex((item) => item.key === selected?.key)
    const after = ordered[i + 1] ?? ordered[i - 1]
    navigate(desktop && after ? `/inbox/${after.key}` : '/', { replace: true })
  }
  const sessionOf = (id: string | null) => (id ? sessions.data?.find((s) => s.id === id) : undefined)

  const chips: { filter: Filter; label: string; count?: number }[] = [
    { filter: 'all', label: 'All', count: open.length },
    { filter: 'blocking', label: 'Blocking', count: counts.blocking },
    { filter: 'decide', label: 'Decide', count: counts.decide },
    { filter: 'report', label: 'Reports', count: counts.report },
    { filter: 'followup', label: 'Follow-up', count: counts.followup },
    { filter: 'done', label: 'Done' },
  ]
  const filters = (
    <div className={styles.filters}>
      {chips.map((c) => (
        <button key={c.filter} type="button" className={styles.chip} data-on={filter === c.filter || undefined} onClick={() => setFilter(c.filter)}>
          {c.label}
          {c.count !== undefined && <b>{c.count}</b>}
        </button>
      ))}
    </div>
  )

  const loading = filter === 'done' ? done.isPending : inbox.isPending
  const error = (filter === 'done' ? done.error : inbox.error)?.message
  const listBody = loading ? <Loading label="Loading inbox…" /> : error ? <div className={styles.error}>{error}</div> : ordered.length === 0 ? (
    <div className={styles.empty}>
      <Inbox size={24} strokeWidth={1.5} />
      {filter === 'done' ? 'Nothing handled yet' : 'Nothing needs you right now'}
    </div>
  ) : (
    (filter === 'done' ? [{ type: null, label: '' }] : sections).map((s) => {
      const group = ordered.filter((item) => s.type === null || item.type === s.type)
      if (!group.length) return null
      return (
        <div key={s.label}>
          {s.label && (filter === 'all' || filter === 'followup') && <div className={styles.section}>{s.label}</div>}
          {group.map((item) => <Row key={item.key} item={item} session={sessionOf(sessionIdOf(item))} active={item.key === selected?.key} done={filter === 'done'} />)}
        </div>
      )
    })
  )

  if (!desktop && selected) {
    return (
      <div className={styles.mobileDetail}>
        <header className={styles.mobileTop}>
          <button type="button" className={styles.back} onClick={() => navigate('/')} aria-label="Back">
            <ChevronLeft size={30} />
          </button>
          <span className={styles.mobileTitle}>{headline(selected).kind}</span>
          {sessionIdOf(selected) && <OpenSession id={sessionIdOf(selected)!} />}
        </header>
        <div className={styles.mobileBody}>
          <Detail item={selected} session={sessionOf(sessionIdOf(selected))} onHandled={next} />
        </div>
      </div>
    )
  }

  if (!desktop) {
    return (
      <div className={styles.mobile}>
        <header className={styles.mobileBrand}>
          <span className={styles.brandName}>
            <img className={styles.mark} src="/favicon.svg" alt="" />
            Inbox
          </span>
          <button type="button" className={styles.iconButton} onClick={() => openNewSession()} aria-label="New session">
            <Plus size={24} />
          </button>
        </header>
        {filters}
        <div ref={list} className={styles.mobileList}>{listBody}</div>
        <TabBar />
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <header className={styles.top}>
        <h1>Inbox</h1>
        {filters}
      </header>
      <div className={styles.split}>
        <div ref={list} className={styles.list}>{listBody}</div>
        <div className={styles.detail}>
          {selected && (
            <div className={styles.column}>
              <Detail key={selected.key} item={selected} session={sessionOf(sessionIdOf(selected))} onHandled={next} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const sessionIdOf = (item: Item): string | null =>
  item.type === 'report' ? item.report.sessionId : item.type === 'todo' ? item.todo.sessionId : item.type === 'unfinished' ? item.unfinished.sessionId : item.request.sessionId

function Row({ item, session, active, done }: { item: Item; session: Session | undefined; active: boolean; done: boolean }) {
  const projectName = useProjectName()
  const { kind, title, line } = headline(item, session)
  const Icon = { report: FileText, decide: CircleHelp, blocking: ShieldAlert, todo: AlarmClock, unfinished: Hourglass }[item.type]
  return (
    <button type="button" className={styles.row} data-active={active || undefined} onClick={() => navigate(`/inbox/${item.key}`)}>
      <span className={styles.rowIcon} data-type={item.type}><Icon size={14} /></span>
      <span className={styles.rowBody}>
        <span className={styles.rowMeta}>
          <b>{kind}</b>
          {item.type === 'blocking' && <span className={styles.blocking}>· Blocking</span>}
          {item.type === 'unfinished' ? <span className={styles.rowSource}>· {projectName(session?.cwd)}</span> : session?.title && <span className={styles.rowSource}>· {session.title}</span>}
          <span className={styles.ago}>{item.type === 'todo' ? formatDay(item.todo.remindOn!) : ago(item.createdAt)}</span>
        </span>
        <span className={styles.rowTitle} data-unread={!done || undefined}>{title}</span>
        {line && <span className={styles.rowLine}>{line}</span>}
      </span>
    </button>
  )
}

function OpenSession({ id }: { id: string }) {
  return (
    <button type="button" className={styles.openSession} onClick={() => navigate(`/s/${id}`)}>
      Open session
      <ArrowUpRight size={14} />
    </button>
  )
}

function Detail({ item, session, onHandled }: { item: Item; session: Session | undefined; onHandled: () => void }) {
  const queryClient = useQueryClient()
  const desktop = useMediaQuery('(min-width: 1024px)')
  const settled = () => {
    queryClient.invalidateQueries({ queryKey: ['inbox'] })
    onHandled()
  }
  // 409（已在别处处理）也当处理完：轮询会把它从列表拿掉
  const resolve = useMutation({ mutationFn: ({ id, body }: { id: string; body: Resolution }) => api.resolvePending(id, body), onSuccess: settled })
  const dismiss = useMutation({ mutationFn: api.dismissPending, onSuccess: settled })
  const markRead = useMutation({ mutationFn: api.markReportRead, onSuccess: settled })
  const dismissReview = useMutation({ mutationFn: api.dismissReview, onSuccess: settled })
  const updateTodo = useMutation({ mutationFn: ({ id, body }: { id: string; body: { done?: boolean; remindOn?: string } }) => api.updateTodo(id, body), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['todos'] }); settled() } })
  const removeSession = useMutation({ mutationFn: ({ id, descendants }: { id: string; descendants: boolean }) => api.deleteSession(id, descendants), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['sessions'] }); settled() } })
  const sessions = useSessions()
  const projectName = useProjectName()
  const sessionId = sessionIdOf(item)
  const pendingProps = { busy: resolve.isPending, error: resolve.error?.message ?? null }

  const source = (
    <div className={styles.source}>
      <span className={styles.sourceTitle}>{session?.title ?? 'Session'}</span>
      {session && <span className={styles.providerChip}>{session.provider}{session.model ? ` · ${formatModel(session.provider, session.model)}` : ''}</span>}
      {desktop && sessionId && <OpenSession id={sessionId} />}
    </div>
  )

  if (item.type === 'unfinished') {
    const u = item.unfinished
    const error = dismissReview.error ?? removeSession.error
    return (
      <>
        {source}
        <h2 className={styles.heading}>{session?.title ?? 'Session'}</h2>
        <div className={styles.nextStep}>
          <span className={styles.nextLabel}>Left off at</span>
          {u.next || 'No next step given'}
        </div>
        <div className={styles.meta}>{projectName(session?.cwd)} · idle since {new Date(u.idleSince).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} onClick={() => navigate(`/s/${u.sessionId}`)}>Continue</button>
          <button type="button" className={styles.ghost} onClick={() => openTodo({ title: session?.title ?? '', note: u.next, cwd: session?.cwd ?? null, sessionId: u.sessionId, remindOn: localDay(7) })}>Later…</button>
          <button
            type="button"
            className={styles.ghost}
            disabled={removeSession.isPending}
            onClick={async () => {
              const choice = await confirmDeleteSession(sessions.data, u.sessionId)
              if (choice) removeSession.mutate({ id: u.sessionId, descendants: choice.descendants })
            }}
          >
            Done, delete session
          </button>
          <button type="button" className={styles.ghost} disabled={dismissReview.isPending} onClick={() => dismissReview.mutate(u.sessionId)}>Dismiss</button>
          {error && <span className={styles.errorText}>{error.message}</span>}
        </div>
        <div className={styles.note}>Checked by the AI title model after the session sat idle for a day. Dismiss keeps the session; it comes back only if the session has new activity.</div>
      </>
    )
  }

  if (item.type === 'todo') {
    const t = item.todo
    return (
      <>
        {session && source}
        <h2 className={styles.heading}>{t.title}</h2>
        {t.note && <div className={styles.todoNote}>{t.note}</div>}
        <div className={styles.meta}>{t.cwd ? `${projectName(t.cwd)} · ` : ''}reminder for {formatDay(t.remindOn!)}</div>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={updateTodo.isPending} onClick={() => updateTodo.mutate({ id: t.id, body: { done: true } })}>Done</button>
          <button type="button" className={styles.ghost} disabled={updateTodo.isPending} onClick={() => updateTodo.mutate({ id: t.id, body: { remindOn: localDay(1) } })}>Tomorrow</button>
          <button type="button" className={styles.ghost} disabled={updateTodo.isPending} onClick={() => updateTodo.mutate({ id: t.id, body: { remindOn: localDay(7) } })}>Next week</button>
          <button type="button" className={styles.ghost} onClick={() => openTodo({ todo: t })}>Edit…</button>
          {updateTodo.error && <span className={styles.errorText}>{updateTodo.error.message}</span>}
        </div>
      </>
    )
  }

  if (item.type === 'report') {
    const r = item.report
    return (
      <>
        {source}
        <h2 className={styles.heading}>{r.title}</h2>
        <AssistantMessage sessionId={sessionId!} text={r.body} streaming={false} />
        <div className={styles.actions}>
          {r.readAt ? <span className={styles.note}>Read {new Date(r.readAt).toLocaleString('en-GB')}</span> : (
            <button type="button" className={styles.primary} disabled={markRead.isPending} onClick={() => markRead.mutate(r.id)}>Mark as read</button>
          )}
          {markRead.error && <span className={styles.errorText}>{markRead.error.message}</span>}
        </div>
      </>
    )
  }

  const r = item.request
  const state = r.status
  if (r.kind === 'approval') {
    return (
      <>
        {source}
        <ApprovalCard request={r} cwd={session?.cwd ?? ''} state={state} decision={null} resolvedAt={r.resolvedAt} {...pendingProps}
          onResolve={(decision) => resolve.mutate({ id: r.id, body: { kind: 'approval', decision } })} />
      </>
    )
  }
  const resolution = r.resolution?.kind === 'question' ? r.resolution : null
  return (
    <>
      {source}
      {r.filed && (
        <>
          <h2 className={styles.heading}>{r.questions[0]?.question}</h2>
          {r.details && <AssistantMessage sessionId={sessionId!} text={r.details} streaming={false} />}
        </>
      )}
      <QuestionCard bare={!!r.filed} request={r} provider={session?.provider ?? 'claude'} state={state} answers={resolution?.answers ?? null} response={resolution?.response ?? null} resolvedAt={r.resolvedAt} {...pendingProps}
        onSubmit={(answers, response) => resolve.mutate({ id: r.id, body: { kind: 'question', answers, response } })} />
      {state === 'pending' && item.type === 'decide' && (
        <div className={styles.actions}>
          <span className={styles.note}>{r.secret ? 'The value is saved to Secrets in Settings; the session only gets its name.' : 'The answer goes back to the session as a new message and resumes it.'}</span>
          <button type="button" className={styles.ghost} disabled={dismiss.isPending} onClick={() => dismiss.mutate(r.id)}>Dismiss</button>
          {dismiss.error && <span className={styles.errorText}>{dismiss.error.message}</span>}
        </div>
      )}
    </>
  )
}

// 显示项目别名；项目已被移除时退回目录名
function useProjectName() {
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: api.listWorkspaces })
  return (cwd: string | undefined | null) => (cwd && workspaces.data?.find((w) => w.path === cwd)?.alias) || cwd?.split('/').pop() || 'Project'
}
