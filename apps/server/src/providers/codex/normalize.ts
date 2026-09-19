import type { ProviderEvent } from '@agentdeck/shared';
import type { ServerNotification } from './schema';
import type { ThreadItem } from './schema/v2';

// app-server 通知 → 统一事件。只显式映射 §7.2 需要的子集，高频 delta（reasoning / 命令输出）直接丢弃，其余归入 provider.raw（AGENTS.md 规则 5）。
// 一个 normalizer 实例对应一个 thread：需要跨通知记住正在流式输出的 agentMessage。
export function createNormalizer() {
  let streaming: { id: string; text: string } | null = null;
  let lastUsage = '';

  function normalize(n: ServerNotification): ProviderEvent[] {
    switch (n.method) {
      case 'item/started':
        if (n.params.item.type === 'agentMessage') {
          streaming = { id: n.params.item.id, text: '' };
          return [];
        }
        return itemStarted(n.params.item);

      case 'item/agentMessage/delta':
        if (!streaming || streaming.id !== n.params.itemId) return [];
        streaming.text += n.params.delta;
        return [{ type: 'message.delta', payload: { messageId: n.params.itemId, text: n.params.delta } }];

      case 'item/completed': {
        const item = n.params.item;
        if (item.type === 'agentMessage') {
          streaming = null;
          return [{ type: 'message.completed', payload: { messageId: item.id, text: item.text } }];
        }
        return itemCompleted(item);
      }

      case 'turn/completed': {
        const events: ProviderEvent[] = [];
        // 被打断的 agentMessage 不会再收到 item/completed（P0 验证），用已累积的文本收尾
        if (streaming) {
          events.push({ type: 'message.completed', payload: { messageId: streaming.id, text: streaming.text } });
          streaming = null;
        }
        const { status, error, durationMs } = n.params.turn;
        if (status === 'failed') events.push({ type: 'turn.failed', payload: { message: error?.message ?? 'turn failed' } });
        else events.push({ type: 'turn.completed', payload: { reason: status === 'interrupted' ? 'interrupted' : 'completed', durationMs: durationMs ?? 0, costUsd: 0 } });
        return events;
      }

      case 'account/rateLimits/updated': {
        // 每次 API 调用都会推一份，没变化就不落库
        const { primary, secondary } = n.params.rateLimits;
        const key = JSON.stringify([primary, secondary]);
        if (key === lastUsage) return [];
        lastUsage = key;
        return Object.entries({ primary, secondary }).flatMap(([rateLimitType, w]) =>
          w
            ? [{ type: 'usage.updated' as const, payload: { provider: 'codex' as const, rateLimitType, utilization: w.usedPercent / 100, resetsAt: w.resetsAt, windowMinutes: w.windowDurationMins } }]
            : [],
        );
      }

      // 高频 delta，UI 不展示；agentMessage 的 delta 已在上面处理
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryPartAdded':
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
      // 生命周期由 Hub 自己记（turn.started 在 dispatch 时发出；userMessage 是 Hub 发出去的回显）
      case 'turn/started':
      case 'thread/started':
        return [];

      default:
        return [{ type: 'provider.raw', payload: { kind: n.method, data: n.params } }];
    }
  }

  return { normalize };
}

// 工具类 item：commandExecution / fileChange / mcpToolCall 各开一张工具卡；其余 item 保留原样
function itemStarted(item: ThreadItem): ProviderEvent[] {
  switch (item.type) {
    case 'commandExecution':
      return [{ type: 'tool.started', payload: { toolUseId: item.id, name: 'shell', input: { command: stripShellWrapper(item.command), cwd: item.cwd } } }];
    case 'fileChange':
      return [{ type: 'tool.started', payload: { toolUseId: item.id, name: 'apply_patch', input: { path: item.changes.map((c) => `${c.kind} ${c.path}`).join(', ') } } }];
    case 'mcpToolCall':
      return [{ type: 'tool.started', payload: { toolUseId: item.id, name: `${item.server}/${item.tool}`, input: item.arguments } }];
    case 'userMessage':
      return [];
    default:
      return [{ type: 'provider.raw', payload: { kind: `item/started/${item.type}`, data: item } }];
  }
}

function itemCompleted(item: ThreadItem): ProviderEvent[] {
  switch (item.type) {
    case 'commandExecution':
      return [{ type: 'tool.completed', payload: { toolUseId: item.id, output: item.aggregatedOutput ?? (item.status === 'declined' ? '用户拒绝执行' : ''), isError: item.status !== 'completed' } }];
    case 'fileChange':
      return [{ type: 'tool.completed', payload: { toolUseId: item.id, output: item.changes.map((c) => c.diff).join('\n'), isError: item.status !== 'completed' } }];
    case 'mcpToolCall':
      return [{ type: 'tool.completed', payload: { toolUseId: item.id, output: item.error ? item.error.message : JSON.stringify(item.result?.content ?? null, null, 2), isError: item.error !== null } }];
    case 'userMessage':
      return [];
    default:
      return [{ type: 'provider.raw', payload: { kind: `item/completed/${item.type}`, data: item } }];
  }
}

// Codex 把命令包成 `/bin/zsh -lc '<cmd>'`，卡片只展示用户能读的那部分
export function stripShellWrapper(command: string): string {
  const m = /^\S+ -lc '([\s\S]*)'$/.exec(command);
  return m ? m[1].replace(/'\\''/g, "'") : command;
}
