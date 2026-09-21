import { useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, GitBranch, Trash2 } from 'lucide-react'
import { Loading } from '../components/Loading'
import type { ProviderId, Resolution } from '@agentdeck/shared'
import { api } from '../api'
import { formatEffort, formatModel, formatTokens, providerName } from '../format'
import { navigate } from '../router'
import { useSessionStream, type StreamItem } from '../session/useSessionStream'
import { groupTools, layout, type Entry } from '../session/layout'
import { useMediaQuery } from '../session/useMediaQuery'
import { useAutoHideScrollbar } from '../session/useAutoHideScrollbar'
import { leaveSession, useSessions } from '../session/useSessions'
import { ChangesPanel } from '../components/ChangesPanel'
import { UserMessage } from '../components/UserMessage'
import { AssistantMessage } from '../components/AssistantMessage'
import { ToolGroup } from '../components/ToolCard'
import { ProcessBlock } from '../components/ProcessBlock'
import { ErrorCard } from '../components/ErrorCard'
import { TurnRow, WorkingRow } from '../components/TurnRow'
import { ConnectionBanner } from '../components/ConnectionBanner'
import { ApprovalCard } from '../components/ApprovalCard'
import { QuestionCard } from '../components/QuestionCard'
import { Composer } from '../components/Composer'
import { dialog } from '../components/Dialog'
import styles from './SessionPage.module.css'

export function SessionPage({ sessionId }: { sessionId: string }) {
  const { session, status, model, items, connection, replay, context, turnStartedAt, gone, changesVersion } = useSessionStream(sessionId)
  const queryClient = useQueryClient()
  // 标题由首条消息生成、Provider 可在空会话时切换，snapshot 里的 session 不会跟着更新；列表查询在这些操作后会失效重取，优先从它读
  const sessions = useSessions()
  const listed = sessions.data?.find((s) => s.id === sessionId)
  const info = listed ?? session
  const title = info?.title ?? 'New session'
  const send = useMutation({
    mutationFn: (body: { text: string; attachmentIds: string[] }) => api.sendMessage(sessionId, body),
    // 首条消息决定列表里的标题；归档中的会话发消息后服务端会自动取消归档
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
  })
  const interrupt = useMutation({ mutationFn: () => api.interrupt(sessionId) })
  // "新开一轮" = 同工作区同 Agent 起一个新会话，等价于 CLI 的 /clear。多数时候旧会话已经没用，所以顺带问一句要不要删。
  // 先建新的、切过去，再删旧的：这样旧会话的 session.deleted 不会打到还开着的页面上；删失败（如刚好又跑起来 409）只提示
  const fresh = useMutation({
    mutationFn: async (discard: boolean) => {
      const s = await api.createSession({ provider: info!.provider, cwd: info!.cwd })
      navigate(`/s/${s.id}`)
      if (discard) await api.deleteSession(sessionId).catch((err: Error) => dialog.alert({ title: 'New session created, but the old one was not deleted', message: err.message }))
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
  })
  // 空会话换 Agent：Provider 进程还没起，服务端只改一列（有消息了会 409）。记成下次新建的默认选择
  const switchProvider = useMutation({
    mutationFn: (provider: ProviderId) => api.updateSession(sessionId, { provider }),
    onSuccess: (s) => {
      localStorage.setItem('newSession:provider', s.provider)
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
    },
  })
  const onFresh = async () => {
    // 运行中的不问，直接保留
    const canDiscard = status === 'idle' || status === 'error'
    const discard =
      canDiscard &&
      (await dialog.confirm({
        title: 'Delete the current session when starting fresh?',
        message: 'The session and all its history will be deleted permanently. Choose "Keep" to leave it in the list and still start fresh.',
        ok: 'Delete and start fresh',
        cancel: 'Keep and start fresh',
        danger: true,
      }))
    // null = 直接关掉弹窗，什么也不做
    if (discard === null) return
    fresh.mutate(discard)
  }
  // 同一时刻只会有一个待处理请求在提交；409（已在别处处理）随后会被 resolved 事件覆盖掉卡片
  const resolve = useMutation({ mutationFn: ({ id, body }: { id: string; body: Resolution }) => api.resolvePending(id, body) })
  const pendingProps = (id: string) => ({
    busy: resolve.isPending && resolve.variables?.id === id,
    error: resolve.error && resolve.variables?.id === id ? resolve.error.message : null,
  })
  // 删除：运行中的服务端会 409，消息原样给用户看；成功后跳到邻居会话。移到 Inactive / 移回在侧栏行上操作
  const remove = useMutation({
    mutationFn: () => api.deleteSession(sessionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      leaveSession(sessions.data, sessionId)
    },
    onError: (err) => dialog.alert({ title: 'Delete failed', message: err.message }),
  })
  const onDelete = async () => {
    if (await dialog.confirm({ title: 'Delete this session?', message: 'The session and all its history will be deleted permanently.', ok: 'Delete', danger: true })) remove.mutate()
  }
  // 在别处被删了：离开页面
  useEffect(() => {
    if (gone) {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      leaveSession(sessions.data, sessionId)
    }
  }, [gone, queryClient])
  // 改动侧栏只在桌面端；开关记在 localStorage，默认开
  const desktop = useMediaQuery('(min-width: 1024px)')
  const page = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const viewport = window.visualViewport
    if (desktop || !viewport) return
    const el = page.current!
    const sync = () => {
      // 键盘和 Safari 工具栏会改变可见区域；首次进入就测量，不依赖聚焦触发 resize。
      // 手动缩放时保留布局，避免页面跟着缩放反复重排。
      if (viewport.scale !== 1) return
      el.style.setProperty('--viewport-height', `${viewport.height}px`)
      el.style.setProperty('--viewport-top', `${viewport.offsetTop}px`)
    }
    sync()
    viewport.addEventListener('resize', sync)
    viewport.addEventListener('scroll', sync)
    window.addEventListener('pageshow', sync)
    return () => {
      viewport.removeEventListener('resize', sync)
      viewport.removeEventListener('scroll', sync)
      window.removeEventListener('pageshow', sync)
      el.style.removeProperty('--viewport-height')
      el.style.removeProperty('--viewport-top')
    }
  }, [desktop, sessionId])
  const [showChanges, setShowChanges] = useState(() => localStorage.getItem('changesPanel') !== 'off')
  const toggleChanges = () => {
    setShowChanges((v) => {
      localStorage.setItem('changesPanel', v ? 'off' : 'on')
      return !v
    })
  }
  const stream = useRef<HTMLElement>(null)
  useAutoHideScrollbar(stream)
  const column = useRef<HTMLDivElement>(null)
  // 用户往上翻看历史时不再自动跟到底部；回到底部附近后恢复跟随
  const follow = useRef(true)
  // 最近一次已知的 scrollTop（我们自己设的或上次 scroll 事件看到的）。scroll 事件比程序滚动晚一帧，
  // 中间若又灌进一大段内容，事件里看到的"离底部很远"并不是用户翻上去了——只有 scrollTop 真的变小才算
  const anchor = useRef(0)
  const onScroll = (e: UIEvent<HTMLElement>) => {
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) follow.current = true
    else if (el.scrollTop < anchor.current) follow.current = false
    anchor.current = el.scrollTop
  }
  // 跟随底部按"高度变了"而不是"事件来了"触发：流式文本、处理中行、卡片出现、底部状态栏换行挤压可视区都算
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
  const positioned = useRef(false)
  useLayoutEffect(() => {
    follow.current = true
    anchor.current = 0
    positioned.current = false
  }, [sessionId])
  useLayoutEffect(() => {
    if (positioned.current || session?.id !== sessionId || connection !== 'open') return
    // 历史回放中过程块折叠会让 scrollTop 回退，不能把它当作用户上翻而漏掉首次定位。
    const el = stream.current!
    follow.current = true
    el.scrollTop = el.scrollHeight
    anchor.current = el.scrollTop
    positioned.current = true
  }, [sessionId, session?.id, connection])

  // 已结束轮次的过程块默认折叠；展开的记在这里（按块 key），换会话清空
  const [opened, setOpened] = useState<Set<string>>(() => new Set())
  useEffect(() => setOpened(new Set()), [sessionId])
  const entries = useMemo(() => layout(items), [items])
  const toggleProcess = (key: string) => {
    // 展开 / 收起改变的是历史区域的高度，不该把视口拽到底部
    follow.current = false
    setOpened((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const running = status === 'running' || status === 'waiting_user'
  // snapshot 到达前先按 claude 渲染，随后被真实 provider 覆盖
  const provider = info?.provider ?? 'claude'
  const canSwitchProvider = !!info && items.length === 0 && !info.providerSessionId && status === 'idle' && !send.isPending && !switchProvider.isPending
  const mutationError = send.error ?? fresh.error ?? interrupt.error ?? switchProvider.error
  const hint = mutationError
    ? mutationError.message
    : connection !== 'open'
      ? 'Connecting…'
      : status === 'waiting_user'
        ? `${provider} will continue once you handle the request above`
        : ''
  // 状态区 Provider 名字后面：模型 · 思考等级 · 上下文用量；init 前模型取创建时指定的；没指定 effort（用 Provider 默认）就不显示
  const meta = [formatModel(provider, model ?? info?.model), formatEffort(provider, info?.effort), context !== null && formatTokens(context)].filter(Boolean).join(' · ')

  const renderItem = (it: StreamItem) => {
    switch (it.kind) {
      case 'user':
        return <UserMessage key={it.key} text={it.text} attachments={it.attachments} at={it.at} />
      case 'assistant':
        return <AssistantMessage key={it.key} text={it.text} streaming={it.streaming} />
      case 'error':
        return <ErrorCard key={it.key} message={it.message} />
      case 'turn':
        return <TurnRow key={it.key} reason={it.reason} durationMs={it.durationMs} at={it.at} />
      case 'approval':
        return (
          <ApprovalCard
            key={it.key}
            request={it.request}
            cwd={session?.cwd ?? ''}
            state={it.state}
            decision={it.decision}
            resolvedAt={it.resolvedAt}
            {...pendingProps(it.request.id)}
            onResolve={(decision) =>
              resolve.mutate({
                id: it.request.id,
                body: { kind: 'approval', decision },
              })
            }
          />
        )
      case 'question':
        return (
          <QuestionCard
            key={it.key}
            request={it.request}
            provider={provider}
            state={it.state}
            answers={it.answers}
            response={it.response}
            resolvedAt={it.resolvedAt}
            {...pendingProps(it.request.id)}
            onSubmit={(answers, response) =>
              resolve.mutate({
                id: it.request.id,
                body: { kind: 'question', answers, response },
              })
            }
          />
        )
    }
  }
  const renderEntries = (list: Entry[]) =>
    list.map((e) => {
      switch (e.kind) {
        case 'tools':
          return <ToolGroup key={e.key} items={e.items} />
        case 'process':
          return (
            <ProcessBlock key={e.key} steps={e.steps} tools={e.tools} open={opened.has(e.key)} onToggle={() => toggleProcess(e.key)}>
              {renderEntries(groupTools(e.items))}
            </ProcessBlock>
          )
        default:
          return renderItem(e)
      }
    })

  return (
    <div ref={page} className={styles.page}>
      <header className={styles.topbar}>
        <button type="button" className={styles.back} onClick={() => navigate('/')} aria-label="Back">
          <ChevronLeft size={20} />
        </button>
        <span className={styles.title} title={session?.cwd}>{title}</span>
        {desktop && (
          <button type="button" className={styles.iconButton} data-active={showChanges || undefined} onClick={toggleChanges} aria-label="Changes panel" title="Show / hide the changes panel">
            <GitBranch size={16} />
          </button>
        )}
        <button type="button" className={styles.iconButton} data-danger onClick={onDelete} disabled={!session || remove.isPending} aria-label="Delete session" title="Delete the session and all its history">
          <Trash2 size={16} />
        </button>
      </header>

      <ConnectionBanner connection={connection} replay={replay} />

      <div className={styles.body}>
        <div className={styles.conversation}>
          <main ref={stream} className={styles.stream} onScroll={onScroll}>
            <div ref={column} className={styles.column}>
              {connection !== 'open' && entries.length === 0 && (
                <Loading label="Loading conversation…" />
              )}
              {renderEntries(entries)}
              {turnStartedAt && running && <WorkingRow since={turnStartedAt} />}
            </div>
          </main>

          <footer className={styles.footer}>
            <div className={styles.column}>
              <Composer
                key={sessionId}
                draftKey={sessionId}
                disabled={status === 'waiting_user' || connection !== 'open'}
                running={running}
                interrupting={interrupt.isPending}
                onInterrupt={() => interrupt.mutate()}
                onFresh={session && !fresh.isPending ? onFresh : undefined}
                provider={provider}
                onSwitchProvider={canSwitchProvider ? (p) => switchProvider.mutate(p) : undefined}
                meta={meta}
                hint={hint}
                hintError={mutationError !== null}
                placeholder={desktop ? `Message ${providerName[provider]} · Enter to send · Shift+Enter for a new line` : `Message ${providerName[provider]}`}
                upload={(file) => api.uploadAttachment(sessionId, file)}
                search={(q) => api.listEntries(sessionId, q)}
                onSend={(text, attachmentIds) => {
                  // 发消息后总是回到底部看回复，哪怕之前翻上去了
                  follow.current = true
                  send.mutate({ text, attachmentIds })
                }}
              />
            </div>
          </footer>
        </div>
        {desktop && showChanges && <ChangesPanel sessionId={sessionId} version={changesVersion} />}
      </div>
    </div>
  )
}
