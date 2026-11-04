import { useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, CornerLeftUp, GitBranch, Network, Trash2 } from 'lucide-react'
import { Loading } from '../components/Loading'
import { skillToken, type ProviderId, type Resolution } from '@agentdeck/shared'
import { api } from '../api'
import { formatEffort, formatModel, formatTokens, providerName } from '../format'
import { backToTab, navigate } from '../router'
import { useSessionStream, type StreamItem } from '../session/useSessionStream'
import { saveDraft } from '../session/drafts'
import { groupTools, layout, type Entry } from '../session/layout'
import { useMediaQuery } from '../session/useMediaQuery'
import { useAutoHideScrollbar } from '../session/useAutoHideScrollbar'
import { confirmDeleteSession, leaveSession, useSessions } from '../session/useSessions'
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
import { FilePreviewDock, openProjectFinder, openProjectTerminal } from '../components/FilePreview'
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
  const parent = info?.parentId ? sessions.data?.find((s) => s.id === info.parentId) : undefined
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
      navigate(`/s/${s.id}`, { replace: discard })
      if (discard) await api.deleteSession(sessionId).catch((err: Error) => dialog.alert({ title: 'New session created, but the old one was not deleted', message: err.message }))
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
  })
  // 分叉 / 原地回退：服务端从这条消息之前复制出新会话，原消息文字预填进新会话输入框（图片不带）。
  // 原地回退 = 分叉后删掉原会话，顺序同「新开一轮」：先跳过去再删，删失败只提示
  const rewind = useMutation({
    mutationFn: async ({ seq, text, inPlace }: { seq: number; text: string; inPlace: boolean }) => {
      const s = await api.forkSession(sessionId, { beforeSeq: seq, rewind: inPlace })
      saveDraft(s.id, text)
      navigate(`/s/${s.id}`, { replace: inPlace })
      if (inPlace) await api.deleteSession(sessionId).catch((err: Error) => dialog.alert({ title: 'Rewound into a new session, but the old one was not deleted', message: err.message }))
    },
    onError: (err) => dialog.alert({ title: 'Rewind failed', message: err.message }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
  })
  const onRewind = async (it: Extract<StreamItem, { kind: 'user' }>) => {
    const inPlace = await dialog.confirm({
      title: 'Go back to before this message?',
      message: 'Continue from the conversation before this message, with the message put back in the input box. "Rewind in place" deletes this session; "Fork" keeps it. Files changed by the agent are not rolled back.',
      ok: 'Rewind in place',
      cancel: 'Fork',
      danger: true,
    })
    if (inPlace === null) return
    rewind.mutate({ seq: it.seq, text: it.text, inPlace })
  }
  // 空会话换 Agent：Provider 进程还没起，服务端只改一列（有消息了会 409）。记成下次新建的默认选择
  const switchProvider = useMutation({
    mutationFn: (provider: ProviderId) => api.updateSession(sessionId, { provider }),
    onSuccess: (s) => {
      localStorage.setItem('newSession:provider', s.provider)
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
    },
  })
  // 空会话换模型 / 思考等级：同上只改列；不记进 localStorage，下个新会话仍用设置页默认值
  const switchModel = useMutation({
    mutationFn: ({ model, effort }: { model: string; effort: string }) => api.updateSession(sessionId, { model, effort }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
  })
  // 事先打开派生授权：用户离开前打开，Agent 之后调 create_session 不再停在审批卡上。打开要二次确认，关掉不用
  const spawnGrant = useMutation({
    mutationFn: (spawnGranted: boolean) => api.updateSession(sessionId, { spawnGranted }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
    onError: (err) => dialog.alert({ title: 'Could not change the setting', message: err.message }),
  })
  const onToggleSpawnGrant = async () => {
    if (!info?.spawnGranted) {
      const ok = await dialog.confirm({
        title: 'Auto-approve new sessions from this session?',
        message: 'The agent in this session can start new sessions without asking you. New sessions run with the default permission mode from Settings. You can turn this off at any time.',
        ok: 'Auto-approve',
      })
      if (!ok) return
    }
    spawnGrant.mutate(!info?.spawnGranted)
  }
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
  // 删除：运行中的服务端会 409，消息原样给用户看；成功后手机回列表，桌面跳到邻居会话。移到 Inactive / 移回在侧栏行上操作
  const remove = useMutation({
    mutationFn: (descendants: boolean) => api.deleteSession(sessionId, descendants),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      leaveSession(sessions.data, sessionId)
    },
    onError: (err) => dialog.alert({ title: 'Delete failed', message: err.message }),
  })
  const onDelete = async () => {
    const choice = await confirmDeleteSession(sessions.data, sessionId)
    if (choice) remove.mutate(choice.descendants)
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
  // 与输入框 $ 补全共用缓存；只有出现 $ 开头的消息才去拉列表（Claude 要起进程扫描）
  const hasSkillMessage = items.some((it) => it.kind === 'user' && skillToken(it.text) !== undefined)
  const skills = useQuery({ queryKey: ['skills', sessionId, provider], queryFn: () => api.listSkills(sessionId), enabled: hasSkillMessage, staleTime: 60_000 })
  const skillOf = (text: string) => {
    const token = skillToken(text)
    return token !== undefined && skills.data?.skills.some((s) => s.name === token) ? token : undefined
  }
  const canSwitchProvider = !!info && items.length === 0 && !info.providerSessionId && status === 'idle' && !send.isPending
  const mutationError = fresh.error ?? interrupt.error ?? switchProvider.error ?? switchModel.error
  const hint = mutationError
    ? mutationError.message
    : connection !== 'open'
      ? 'Connecting…'
      : status === 'waiting_user'
        ? `${provider} will continue once you handle the request above`
        : status === 'idle' && info?.backgroundTasks
          ? `${provider} will continue when its background task finishes`
          : ''
  // 状态区 Provider 名字后面：模型 · 思考等级 · 上下文用量；init 前模型取创建时指定的；没指定 effort（用 Provider 默认）就不显示
  const meta = [formatModel(provider, model ?? info?.model), formatEffort(provider, info?.effort), context !== null && formatTokens(context)].filter(Boolean).join(' · ')

  // 每轮落款上的复制取这轮最后一段回复，方便转贴给别的会话
  const replies = new Map<string, string>()
  let reply = ''
  for (const it of items) {
    if (it.kind === 'assistant') reply = it.text
    else if (it.kind === 'user') reply = ''
    else if (it.kind === 'turn') {
      if (reply) replies.set(it.key, reply)
      reply = ''
    }
  }
  const renderItem = (it: StreamItem) => {
    switch (it.kind) {
      case 'user':
        return <UserMessage key={it.key} text={it.text} attachments={it.attachments} at={it.at} skill={skillOf(it.text)} onRewind={it.forkable && !running && !rewind.isPending ? () => onRewind(it) : undefined} />
      case 'assistant':
        return <AssistantMessage sessionId={sessionId} key={it.key} text={it.text} streaming={it.streaming} />
      case 'error':
        return <ErrorCard key={it.key} message={it.message} />
      case 'turn':
        return <TurnRow key={it.key} reason={it.reason} durationMs={it.durationMs} at={it.at} reply={replies.get(it.key)} />
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
        <button type="button" className={styles.back} onClick={() => backToTab()} aria-label="Back">
          <ChevronLeft size={20} />
        </button>
        <span className={styles.title} title={session?.cwd}>{title}</span>
        {parent && (
          <button type="button" className={styles.iconButton} onClick={() => navigate(`/s/${parent.id}`)} aria-label="Open parent session" title={`Started by ${parent.title ?? 'New session'}`}>
            <CornerLeftUp size={16} />
          </button>
        )}
        {desktop && (
          <button type="button" className={styles.iconButton} data-active={showChanges || undefined} onClick={toggleChanges} aria-label="Project panel" title="Show / hide changes and files">
            <GitBranch size={16} />
          </button>
        )}
        <button type="button" className={styles.iconButton} data-active={info?.spawnGranted || undefined} onClick={onToggleSpawnGrant} disabled={!info || spawnGrant.isPending} aria-label="Auto-approve new sessions" aria-pressed={!!info?.spawnGranted} title={info?.spawnGranted ? 'New sessions started by this agent are auto-approved. Click to require approval again' : 'Auto-approve new sessions started by this agent'}>
          <Network size={16} />
        </button>
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
              {send.error && <ErrorCard message={`Send failed. Your message is still in the input box. You can try again.\n${send.error.message}`} />}
              <Composer
                key={sessionId}
                draftKey={sessionId}
                disabled={status === 'waiting_user' || connection !== 'open'}
                sending={send.isPending}
                running={running}
                interrupting={interrupt.isPending}
                onInterrupt={() => interrupt.mutate()}
                onTerminal={desktop && info?.cwd ? () => openProjectTerminal(info.cwd) : undefined}
                onFinder={desktop && info?.cwd ? () => openProjectFinder(info.cwd) : undefined}
                onFresh={session && !fresh.isPending ? onFresh : undefined}
                // Hub 对运行中 / 等待中 / 空会话的 /compact 回 409，这里提前置灰
                canCompact={items.length > 0 && (status === 'idle' || status === 'error')}
                provider={provider}
                imagesAllowed={provider !== 'deepseek' || info?.model !== 'deepseek-v4-pro'}
                onSwitchProvider={canSwitchProvider ? (p) => switchProvider.mutate(p) : undefined}
                switchingPending={switchProvider.isPending || switchModel.isPending}
                modelSelect={canSwitchProvider ? { model: info.model ?? '', effort: info.effort ?? '', onChange: (m, e) => switchModel.mutate({ model: m, effort: e }) } : undefined}
                meta={meta}
                hint={hint}
                hintError={mutationError !== null}
                placeholder={desktop ? `Message ${providerName[provider]} · # sessions · Enter to send · Shift+Enter for a new line` : `Message ${providerName[provider]}`}
                upload={(file) => api.uploadAttachment(sessionId, file)}
                search={(q) => api.listEntries(sessionId, q)}
                listSkills={() => api.listSkills(sessionId)}
                onSend={(text, attachmentIds) => {
                  // 发消息后总是回到底部看回复，哪怕之前翻上去了
                  follow.current = true
                  return send.mutateAsync({ text, attachmentIds }).then(() => true, () => false)
                }}
              />
            </div>
          </footer>
        </div>
        {desktop && <FilePreviewDock key={`preview:${sessionId}`} version={changesVersion} />}
        {desktop && showChanges && <ChangesPanel key={sessionId} sessionId={sessionId} cwd={info?.cwd ?? ''} version={changesVersion} busy={status === 'running' || status === 'waiting_user' || (info?.backgroundTasks ?? 0) > 0} />}
      </div>
    </div>
  )
}
