import { useEffect, useRef, useState, type UIEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, GitBranch, MessageSquarePlus, Square, Trash2 } from 'lucide-react'
import type { Resolution } from '@agentdeck/shared'
import { api } from '../api'
import { providerName } from '../format'
import { navigate } from '../router'
import { useSessionStream } from '../session/useSessionStream'
import { useMediaQuery } from '../session/useMediaQuery'
import { ChangesPanel } from '../components/ChangesPanel'
import { StatusPill } from '../components/StatusPill'
import { UserMessage } from '../components/UserMessage'
import { AssistantMessage } from '../components/AssistantMessage'
import { ToolCard } from '../components/ToolCard'
import { ErrorCard } from '../components/ErrorCard'
import { InterruptedRow } from '../components/InterruptedRow'
import { RateMeter } from '../components/RateMeter'
import { ConnectionBanner } from '../components/ConnectionBanner'
import { ApprovalCard } from '../components/ApprovalCard'
import { QuestionCard } from '../components/QuestionCard'
import { Composer } from '../components/Composer'
import styles from './SessionPage.module.css'

export function SessionPage({ sessionId }: { sessionId: string }) {
  const { session, status, model, items, lastSeq, connection, replay, usage, gone, changesVersion } = useSessionStream(sessionId)
  const queryClient = useQueryClient()
  const send = useMutation({
    mutationFn: (body: { text: string; attachmentIds: string[] }) => api.sendMessage(sessionId, body),
    // 首条消息决定列表里的标题
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sessions'] }),
  })
  const interrupt = useMutation({ mutationFn: () => api.interrupt(sessionId) })
  // "新开一轮" = 同工作区同 Agent 起一个新会话，等价于 CLI 的 /clear；旧会话记录保留
  const fresh = useMutation({
    mutationFn: () => api.createSession({ provider: session!.provider, cwd: session!.cwd }),
    onSuccess: (s) => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      navigate(`/s/${s.id}`)
    },
  })
  // 同一时刻只会有一个待处理请求在提交；409（已在别处处理）随后会被 resolved 事件覆盖掉卡片
  const resolve = useMutation({ mutationFn: ({ id, body }: { id: string; body: Resolution }) => api.resolvePending(id, body) })
  const pendingProps = (id: string) => ({
    busy: resolve.isPending && resolve.variables?.id === id,
    error: resolve.error && resolve.variables?.id === id ? resolve.error.message : null,
  })
  // 运行中的服务端会 409，消息原样给用户看；成功后列表刷新并回首页
  const remove = useMutation({
    mutationFn: () => api.deleteSession(sessionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      navigate('/')
    },
    onError: (err) => alert(err.message),
  })
  const onDelete = () => {
    if (confirm('删除这个会话及其全部记录？此操作不可恢复。')) remove.mutate()
  }
  // 在别处被删了：离开页面
  useEffect(() => {
    if (gone) {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
      navigate('/')
    }
  }, [gone, queryClient])
  // 改动侧栏只在桌面端；开关记在 localStorage，默认开
  const desktop = useMediaQuery('(min-width: 1024px)')
  const [showChanges, setShowChanges] = useState(() => localStorage.getItem('changesPanel') !== 'off')
  const toggleChanges = () => {
    setShowChanges((v) => {
      localStorage.setItem('changesPanel', v ? 'off' : 'on')
      return !v
    })
  }
  const bottom = useRef<HTMLDivElement>(null)
  // 用户往上翻看历史时不再自动跟到底部；回到底部附近后恢复跟随
  const follow = useRef(true)
  const onScroll = (e: UIEvent<HTMLElement>) => {
    const el = e.currentTarget
    follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  useEffect(() => {
    if (follow.current) bottom.current?.scrollIntoView({ block: 'end' })
  }, [items])

  const running = status === 'running' || status === 'waiting_user'
  // snapshot 到达前先按 claude 渲染，随后被真实 provider 覆盖
  const provider = session?.provider ?? 'claude'
  const hint = send.error
    ? send.error.message
    : fresh.error
      ? fresh.error.message
      : interrupt.error
        ? interrupt.error.message
        : connection !== 'open'
          ? '等待连接…'
          : status === 'waiting_user'
            ? `处理上方的请求后 ${provider} 才会继续`
            : status === 'running'
              ? '当前有一轮在运行，发送将作为追加指令排队'
              : 'Enter 发送，Shift+Enter 换行'

  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <button type="button" className={styles.back} onClick={() => navigate('/')} aria-label="返回">
          <ChevronLeft size={20} />
        </button>
        <div className={styles.title}>
          <code className={styles.cwd}>{session?.cwd ?? '…'}</code>
          <span className={styles.sub}>
            <code className={styles.chip}>{provider}</code>
            {model && <code className={styles.chip}>{model}</code>}
            <code>seq {lastSeq}</code>
          </span>
        </div>
        <div className={styles.meter}>
          <RateMeter provider={provider} usage={usage} />
        </div>
        <button type="button" className={styles.fresh} onClick={() => fresh.mutate()} disabled={!session || fresh.isPending} title="同工作区新开一个会话，清空上下文">
          <MessageSquarePlus size={16} />
          <span className={styles.freshLabel}>新开一轮</span>
        </button>
        {desktop && (
          <button type="button" className={styles.iconButton} data-active={showChanges || undefined} onClick={toggleChanges} aria-label="改动侧栏" title="显示 / 隐藏改动侧栏">
            <GitBranch size={16} />
          </button>
        )}
        <button type="button" className={styles.iconButton} data-danger onClick={onDelete} disabled={!session || remove.isPending} aria-label="删除会话" title="删除会话及其全部记录">
          <Trash2 size={16} />
        </button>
        {running && (
          <button type="button" className={styles.interrupt} onClick={() => interrupt.mutate()} disabled={interrupt.isPending}>
            <Square size={12} />
            中断
          </button>
        )}
        <StatusPill status={status} />
      </header>

      <ConnectionBanner connection={connection} replay={replay} />

      <div className={styles.body}>
        <div className={styles.conversation}>
          <main className={styles.stream} onScroll={onScroll}>
            <div className={styles.column}>
              {items.map((it) => {
                switch (it.kind) {
                  case 'user':
                    return <UserMessage key={it.key} text={it.text} attachments={it.attachments} at={it.at} />
                  case 'assistant':
                    return <AssistantMessage key={it.key} provider={provider} text={it.text} streaming={it.streaming} at={it.at} />
                  case 'tool':
                    return <ToolCard key={it.key} name={it.name} input={it.input} output={it.output} isError={it.isError} />
                  case 'error':
                    return <ErrorCard key={it.key} message={it.message} />
                  case 'interrupted':
                    return <InterruptedRow key={it.key} at={it.at} />
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
              })}
              <div ref={bottom} />
            </div>
          </main>

          <footer className={styles.footer}>
            <div className={styles.column}>
              <Composer
                key={sessionId}
                draftKey={sessionId}
                disabled={status === 'waiting_user' || connection !== 'open'}
                hint={hint}
                placeholder={`给 ${providerName[provider]} 发消息…`}
                upload={(file) => api.uploadAttachment(sessionId, file)}
            search={(q) => api.listEntries(sessionId, q)}
                onSend={(text, attachmentIds) => send.mutate({ text, attachmentIds })}
              />
            </div>
          </footer>
        </div>
        {desktop && showChanges && <ChangesPanel sessionId={sessionId} version={changesVersion} />}
      </div>
    </div>
  )
}
