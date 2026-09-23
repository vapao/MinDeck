import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ProviderEvent, ProviderOutput } from '@agentdeck/shared';
import { summarizeToolInput } from '../summary';

// SDK 消息 → 统一事件。只显式映射 §7.2 需要的子集，其余直接丢弃（AGENTS.md 规则 5）。
// 一个 normalizer 实例对应一个 session：需要跨消息记住当前正在流式输出的 assistant 消息 ID。
export function createNormalizer(resumed: boolean) {
  let streamingMessageId: string | null = null;
  let started = false;
  let interrupting = false;
  let lastUsage = '';
  let lastContext = 0;
  // 一轮进行中插入的消息若没赶上工具边界，SDK 会在其后自成一轮、多出一个 result；只在 idle 时报最后那个结果
  let turnEnd: ProviderEvent<'turn.completed' | 'turn.failed'> | null = null;
  // 最后一条主链消息（顶层 assistant / user，含中断标记）的 uuid：一轮结束时作为分叉锚点，SDK forkSession 截到它为止（P0 已验证）
  let lastChainUuid: string | undefined;
  // AskUserQuestion 的 tool_use / tool_result 不开工具卡：提问与回答由 canUseTool 产生的 user_input 事件承载，再出一张卡是冗余
  const hiddenToolIds = new Set<string>();

  function normalize(m: SDKMessage): ProviderOutput[] {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          // SDK 每轮都会发一次 init，只有第一次才是"会话建立 / 恢复"
          if (started) return [];
          started = true;
          return [{ type: resumed ? 'session.resumed' : 'session.started', payload: { providerSessionId: m.session_id, model: m.model } }];
        }
        if (m.subtype === 'session_state_changed' && m.state === 'idle' && turnEnd) {
          const event = turnEnd;
          turnEnd = null;
          event.payload.anchor = lastChainUuid;
          return [event];
        }
        return [];

      case 'rate_limit_event': {
        // 实际消息里各窗口的利用率在 unifiedWindows（SDK 类型未声明）；顶层字段只有 rateLimitType / resetsAt
        const info = m.rate_limit_info as typeof m.rate_limit_info & { unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }> };
        const windows = info.unifiedWindows ?? (info.rateLimitType ? { [info.rateLimitType]: info } : {});
        // 每次 API 调用都会推一份，没变化就不落库
        const key = JSON.stringify(windows);
        if (key === lastUsage) return [];
        lastUsage = key;
        return Object.entries(windows).flatMap(([rateLimitType, w]) =>
          w.utilization === undefined
            ? []
            : [{ type: 'usage.updated' as const, payload: { provider: 'claude' as const, rateLimitType, utilization: w.utilization, resetsAt: w.resetsAt ?? null, windowMinutes: null } }],
        );
      }

      case 'stream_event': {
        const e = m.event;
        if (e.type === 'message_start') streamingMessageId = e.message.id;
        if (e.type === 'content_block_delta' && e.delta.type === 'text_delta' && streamingMessageId) {
          return [{ type: 'message.delta', messageId: streamingMessageId, text: e.delta.text }];
        }
        return [];
      }

      case 'assistant': {
        // 一条完整的 API 响应：文本块合并成 message.completed（覆盖之前 delta 拼出的文本），tool_use 块各自开一张工具卡
        const events: ProviderEvent[] = [];
        if (m.parent_tool_use_id === null) lastChainUuid = m.uuid;
        // 上下文大小 = 本次调用的 prompt 侧 token；子 Agent（parent_tool_use_id 非空）有自己的上下文，不算
        const u = m.message.usage;
        const context = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        if (m.parent_tool_use_id === null && context !== lastContext) {
          lastContext = context;
          events.push({ type: 'context.updated', payload: { tokens: context } });
        }
        const text = m.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        if (text) events.push({ type: 'message.completed', payload: { messageId: m.message.id, text } });
        for (const b of m.message.content) {
          if (b.type !== 'tool_use') continue;
          if (b.name === 'AskUserQuestion') hiddenToolIds.add(b.id);
          else events.push({ type: 'tool.started', payload: { toolUseId: b.id, name: b.name, summary: summarizeToolInput(b.input) } });
        }
        streamingMessageId = null;
        return events;
      }

      case 'user': {
        if (m.parent_tool_use_id === null && m.uuid) lastChainUuid = m.uuid;
        // 只关心 tool_result 的成败；输出本身不保存（用户不看，白占体积）。其余 user 消息是 Hub 自己发出去的回显，UI 已经有了
        if (typeof m.message.content === 'string') return [];
        return m.message.content.flatMap((b): ProviderEvent[] =>
          b.type !== 'tool_result' || hiddenToolIds.has(b.tool_use_id) ? [] : [{ type: 'tool.completed', payload: { toolUseId: b.tool_use_id, isError: b.is_error === true } }],
        );
      }

      case 'result': {
        const wasInterrupting = interrupting;
        interrupting = false;
        if (m.subtype === 'success') {
          turnEnd = { type: 'turn.completed', payload: { reason: 'completed', durationMs: m.duration_ms, costUsd: m.total_cost_usd } };
        } else if (wasInterrupting && m.subtype === 'error_during_execution') {
          // interrupt 后 SDK 返回 error_during_execution（AGENTS.md 规则 3），是用户中断而不是错误
          turnEnd = { type: 'turn.completed', payload: { reason: 'interrupted', durationMs: m.duration_ms, costUsd: m.total_cost_usd } };
        } else {
          turnEnd = { type: 'turn.failed', payload: { message: m.errors.length ? m.errors.join('\n') : m.subtype } };
        }
        return [];
      }

      default:
        return [];
    }
  }

  return {
    normalize,
    /** 调用 q.interrupt() 前标记：接下来那个 error_during_execution 结果按中断处理 */
    markInterrupting() {
      interrupting = true;
    },
  };
}
