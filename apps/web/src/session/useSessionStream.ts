import { useEffect, useReducer, useRef } from 'react'
import type { AgentEvent, ApprovalDecision, Attachment, PendingRequest, QuestionAnswers, ServerMessage, Session, SessionStatus, TurnEndReason } from '@mindeck/shared'

// 会话页的实时状态 = 对事件流做 reduce（方案 §13.1）。一个 seq 只处理一次，重放与 live 共用同一条路径。

export type StreamItem =
  /** forkable：这条消息开启了一轮，且上一轮留有分叉锚点，可以从它之前分叉 / 回退 */
  | { kind: 'user'; key: string; seq: number; text: string; attachments: Attachment[]; at: string; forkable: boolean }
  /** endsReply：一轮中途答完一段的最后一条回复，折叠时和整轮的最后一条一样保持可见 */
  | { kind: 'assistant'; key: string; messageId: string; text: string; streaming: boolean; endsReply?: boolean }
  /** done 为 false 表示还在跑；服务端不保存工具输出，卡片只显示做了什么 */
  | { kind: 'tool'; key: string; toolUseId: string; name: string; summary: string; done: boolean; isError: boolean; at: string }
  | { kind: 'error'; key: string; seq: number; message: string; at: string }
  /** 一轮结束的落款：完成 / 中断 及用时；forkable：留有分叉锚点，可从这轮之后分叉 */
  | { kind: 'turn'; key: string; seq: number; reason: TurnEndReason; durationMs: number; at: string; forkable: boolean }
  | { kind: 'approval'; key: string; request: Extract<PendingRequest, { kind: 'approval' }>; state: PendingState; decision: ApprovalDecision | null; resolvedAt: string | null }
  | { kind: 'question'; key: string; request: Extract<PendingRequest, { kind: 'question' }>; state: PendingState; answers: QuestionAnswers | null; response: string | null; resolvedAt: string | null }

export type PendingState = 'pending' | 'resolved' | 'expired'

export type StreamState = {
  session: Session | null
  status: SessionStatus
  /** Provider 启动 / 恢复时报告的模型；首轮 init 前为 null */
  model: string | null
  items: StreamItem[]
  lastSeq: number
  /** connecting：首次连接；reconnecting：掉线后自动重连中；open：已连上 */
  connection: 'connecting' | 'reconnecting' | 'open'
  /** 最近一次重连补齐的事件范围，给 ConnectionBanner 用；几秒后清空 */
  replay: { from: number; to: number } | null
  /** snapshot 里仍在等待的请求 id；重放结束后据此把陈旧的 pending 卡片标成已过期 */
  livePendingIds: string[]
  /** 最近一次模型调用的上下文 token 数；还没跑过为 null */
  context: number | null
  /** 当前这一轮的开始时间，给底部"处理中"计时用；没有在跑的轮次为 null */
  turnStartedAt: string | null
  /** 会话已被删除（或订阅时就不存在）：页面应离开，连接不再重试 */
  gone: boolean
  /** 工作区可能变了（工具完成 / 一轮结束）就 +1，改动侧栏据此刷新 */
  changesVersion: number
  /** 下一轮开头的消息能否分叉：还没有过轮次，或上一轮结束时带了锚点（与服务端 forkSession 的判断一致） */
  nextForkable: boolean
}

type Action =
  | { type: 'server'; message: ServerMessage }
  | { type: 'connection'; value: StreamState['connection'] }
  | { type: 'replay.dismiss' }
  | { type: 'reset' }

const initial: StreamState = { session: null, status: 'idle', model: null, items: [], lastSeq: 0, connection: 'connecting', replay: null, livePendingIds: [], context: null, turnStartedAt: null, gone: false, changesVersion: 0, nextForkable: true }

function reduce(state: StreamState, action: Action): StreamState {
  if (action.type === 'reset') return initial
  if (action.type === 'connection') return { ...state, connection: action.value }
  if (action.type === 'replay.dismiss') return { ...state, replay: null }
  const m = action.message
  switch (m.type) {
    case 'snapshot':
      // 重连时的 snapshot 记下本地已有的 seq，replay.completed 时据此算出补齐了多少
      return {
        ...state,
        session: m.session,
        status: m.session.status,
        livePendingIds: m.pendingRequests.map((r) => r.id),
        replay: state.connection === 'reconnecting' ? { from: state.lastSeq, to: state.lastSeq } : null,
      }
    case 'event':
      if (m.event.seq <= state.lastSeq) return state
      return applyEvent({ ...state, lastSeq: m.event.seq }, m.event)
    // 流式片段不占 seq：追加到对应消息上，没见过这条消息就新开一条
    case 'message.delta':
      return { ...state, items: mergeAssistantText(state.items, m.messageId, m.text, false) }
    case 'session.deleted':
      return { ...state, gone: true }
    case 'error':
      return m.code === 'not_found' ? { ...state, gone: true } : state
    case 'replay.completed':
      return {
        ...state,
        connection: 'open',
        replay: state.replay && { ...state.replay, to: state.lastSeq },
        items: state.items.map((it) =>
          (it.kind === 'approval' || it.kind === 'question') && it.state === 'pending' && !state.livePendingIds.includes(it.request.id)
            ? { ...it, state: 'expired' }
            : it,
        ),
      }
    default:
      return state
  }
}

// completed 携带完整文本，覆盖 delta 拼接结果（掉线期间丢掉的片段由此补齐）
function mergeAssistantText(items: StreamItem[], messageId: string, text: string, done: boolean): StreamItem[] {
  const i = items.findIndex((it) => it.kind === 'assistant' && it.messageId === messageId)
  if (i === -1) return [...items, { kind: 'assistant', key: messageId, messageId, text, streaming: !done }]
  const cur = items[i] as Extract<StreamItem, { kind: 'assistant' }>
  return items.toSpliced(i, 1, { ...cur, text: done ? text : cur.text + text, streaming: !done })
}

function applyEvent(state: StreamState, e: AgentEvent): StreamState {
  const items = state.items
  switch (e.type) {
    case 'message.user':
      return { ...state, items: [...items, { kind: 'user', key: `u${e.seq}`, seq: e.seq, text: e.payload.text, attachments: e.payload.attachments ?? [], at: e.createdAt, forkable: false }] }
    case 'message.completed':
      return { ...state, items: mergeAssistantText(items, e.payload.messageId, e.payload.text, true) }
    case 'tool.started':
      return {
        ...state,
        items: [...items, { kind: 'tool', key: e.payload.toolUseId, toolUseId: e.payload.toolUseId, name: e.payload.name, summary: e.payload.summary, done: false, isError: false, at: e.createdAt }],
      }
    case 'tool.completed': {
      const i = items.findIndex((it) => it.kind === 'tool' && it.toolUseId === e.payload.toolUseId)
      if (i === -1) return state
      const cur = items[i] as Extract<StreamItem, { kind: 'tool' }>
      return { ...state, changesVersion: state.changesVersion + 1, items: items.toSpliced(i, 1, { ...cur, done: true, isError: e.payload.isError }) }
    }
    case 'approval.requested':
      return { ...state, items: [...items, { kind: 'approval', key: e.payload.request.id, request: e.payload.request, state: 'pending', decision: null, resolvedAt: null }] }
    case 'user_input.requested':
      return { ...state, items: [...items, { kind: 'question', key: e.payload.request.id, request: e.payload.request, state: 'pending', answers: null, response: null, resolvedAt: null }] }
    case 'approval.resolved': {
      const i = items.findIndex((it) => it.kind === 'approval' && it.request.id === e.payload.requestId)
      if (i === -1) return state
      const cur = items[i] as Extract<StreamItem, { kind: 'approval' }>
      const { decision } = e.payload
      const next = decision === 'expired' ? { state: 'expired' as const, decision: null } : { state: 'resolved' as const, decision }
      return { ...state, items: items.toSpliced(i, 1, { ...cur, ...next, resolvedAt: e.createdAt }) }
    }
    case 'user_input.resolved': {
      const i = items.findIndex((it) => it.kind === 'question' && it.request.id === e.payload.requestId)
      if (i === -1) return state
      const cur = items[i] as Extract<StreamItem, { kind: 'question' }>
      return { ...state, items: items.toSpliced(i, 1, { ...cur, state: e.payload.answers ? 'resolved' : 'expired', answers: e.payload.answers, response: e.payload.response ?? null, resolvedAt: e.createdAt }) }
    }
    case 'turn.started': {
      // 开启这一轮的消息紧挨在 turn.started 前面
      const last = items.at(-1)
      const started = last?.kind === 'user' && last.seq === e.seq - 1 ? items.toSpliced(-1, 1, { ...last, forkable: state.nextForkable }) : items
      return { ...state, turnStartedAt: e.createdAt, nextForkable: false, items: started }
    }
    case 'reply.completed': {
      const i = items.findLastIndex((it) => it.kind === 'assistant')
      return i === -1 ? state : { ...state, items: items.toSpliced(i, 1, { ...(items[i] as Extract<StreamItem, { kind: 'assistant' }>), endsReply: true }) }
    }
    case 'turn.failed':
      return { ...state, turnStartedAt: null, nextForkable: !!e.payload.anchor, items: [...items, { kind: 'error', key: `e${e.seq}`, seq: e.seq, message: e.payload.message, at: e.createdAt }] }
    case 'error':
      return { ...state, items: [...items, { kind: 'error', key: `e${e.seq}`, seq: e.seq, message: e.payload.message, at: e.createdAt }] }
    case 'turn.completed':
      return {
        ...state,
        turnStartedAt: null,
        nextForkable: !!e.payload.anchor,
        changesVersion: state.changesVersion + 1,
        items: [...items, { kind: 'turn', key: `t${e.seq}`, seq: e.seq, reason: e.payload.reason, durationMs: e.payload.durationMs, at: e.createdAt, forkable: !!e.payload.anchor }],
      }
    case 'context.updated':
      return { ...state, context: e.payload.tokens }
    case 'session.status':
      return { ...state, status: e.payload.status }
    case 'session.started':
    case 'session.resumed':
      return { ...state, model: e.payload.model }
    default:
      return state
  }
}

// 心跳：iOS 切后台 / 网络切换时 socket 常常"假活"，收不到 close；ping 后超时没回应就主动关掉触发重连
const pingInterval = 25_000
const pongTimeout = 10_000
const maxBackoff = 15_000

export function useSessionStream(sessionId: string): StreamState {
  const [state, dispatch] = useReducer(reduce, initial)
  // 重连时带上已有 seq，只补缺的事件；放 ref 是为了不让连接 effect 依赖 state
  const lastSeq = useRef(0)
  useEffect(() => {
    lastSeq.current = state.lastSeq
  }, [state.lastSeq])

  useEffect(() => {
    dispatch({ type: 'reset' })
    // reset 要到下次渲染才反映到 ref，切换会话时不能带着上一个会话的 seq 去订阅
    lastSeq.current = 0
    let ws: WebSocket | null = null
    let stopped = false
    let attempts = 0
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let pingTimer: ReturnType<typeof setInterval> | undefined
    let pongTimer: ReturnType<typeof setTimeout> | undefined
    let dismissTimer: ReturnType<typeof setTimeout> | undefined

    const clearHeartbeat = () => {
      clearInterval(pingTimer)
      clearTimeout(pongTimer)
    }
    const connect = () => {
      clearTimeout(retryTimer)
      if (stopped || (ws && ws.readyState <= WebSocket.OPEN)) return
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
      ws = socket
      socket.onopen = () => {
        attempts = 0
        socket.send(JSON.stringify({ type: 'subscribe', sessionId, afterSeq: lastSeq.current }))
        pingTimer = setInterval(() => {
          socket.send(JSON.stringify({ type: 'ping' }))
          pongTimer = setTimeout(() => socket.close(), pongTimeout)
        }, pingInterval)
      }
      socket.onmessage = (ev) => {
        const message = JSON.parse(ev.data as string) as ServerMessage
        if (message.type === 'pong') return clearTimeout(pongTimer)
        dispatch({ type: 'server', message })
        // 会话没了就别再重连
        if (message.type === 'session.deleted' || (message.type === 'error' && message.code === 'not_found')) {
          stopped = true
          socket.close()
        }
        if (message.type === 'replay.completed') {
          clearTimeout(dismissTimer)
          dismissTimer = setTimeout(() => dispatch({ type: 'replay.dismiss' }), 5000)
        }
      }
      socket.onclose = () => {
        clearHeartbeat()
        if (stopped) return
        dispatch({ type: 'connection', value: 'reconnecting' })
        retryTimer = setTimeout(connect, Math.min(maxBackoff, 1000 * 2 ** attempts++))
      }
    }
    // 回到前台 / 网络恢复时不等退避，立刻重试
    const wake = () => {
      if (document.visibilityState === 'visible') connect()
    }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)
    connect()

    return () => {
      stopped = true
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake)
      clearTimeout(retryTimer)
      clearTimeout(dismissTimer)
      clearHeartbeat()
      ws?.close()
    }
  }, [sessionId])

  return state
}
