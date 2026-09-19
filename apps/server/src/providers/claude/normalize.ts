import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ProviderEvent } from '@agentdeck/shared';

// SDK 消息 → 统一事件。只显式映射 §7.2 需要的子集，其余归入 provider.raw（AGENTS.md 规则 5）。
// 一个 normalizer 实例对应一个 session：需要跨消息记住当前正在流式输出的 assistant 消息 ID。
export function createNormalizer() {
  let streamingMessageId: string | null = null;

  return function normalize(m: SDKMessage): ProviderEvent[] {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          return [{ type: 'session.started', payload: { providerSessionId: m.session_id, model: m.model } }];
        }
        return [raw(m)];

      case 'stream_event': {
        const e = m.event;
        if (e.type === 'message_start') streamingMessageId = e.message.id;
        if (e.type === 'content_block_delta' && e.delta.type === 'text_delta' && streamingMessageId) {
          return [{ type: 'message.delta', payload: { messageId: streamingMessageId, text: e.delta.text } }];
        }
        return [];
      }

      case 'assistant': {
        // 一条完整的 API 响应：文本块合并成 message.completed（覆盖之前 delta 拼出的文本），tool_use 块各自开一张工具卡
        const events: ProviderEvent[] = [];
        const text = m.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        if (text) events.push({ type: 'message.completed', payload: { messageId: m.message.id, text } });
        for (const b of m.message.content) {
          if (b.type === 'tool_use') {
            events.push({ type: 'tool.started', payload: { toolUseId: b.id, name: b.name, input: b.input } });
          }
        }
        streamingMessageId = null;
        return events;
      }

      case 'user': {
        // 只关心 tool_result；其余 user 消息是 Hub 自己发出去的回显，UI 已经有了
        if (typeof m.message.content === 'string') return [];
        return m.message.content.flatMap((b): ProviderEvent[] => {
          if (b.type !== 'tool_result') return [];
          const output =
            typeof b.content === 'string'
              ? b.content
              : (b.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
          return [{ type: 'tool.completed', payload: { toolUseId: b.tool_use_id, output, isError: b.is_error === true } }];
        });
      }

      case 'result':
        if (m.subtype === 'success') {
          return [{ type: 'turn.completed', payload: { reason: 'completed', durationMs: m.duration_ms, costUsd: m.total_cost_usd } }];
        }
        // TODO(切片 4)：interrupt 后 SDK 也返回 error_during_execution（AGENTS.md 规则 3），届时由 Provider 标记并映射为 reason: 'interrupted'
        return [{ type: 'turn.failed', payload: { message: m.errors.length ? m.errors.join('\n') : m.subtype } }];

      default:
        return [raw(m)];
    }
  };
}

function raw(m: SDKMessage): ProviderEvent<'provider.raw'> {
  const kind = 'subtype' in m && typeof m.subtype === 'string' ? `${m.type}/${m.subtype}` : m.type;
  return { type: 'provider.raw', payload: { kind, data: m } };
}
