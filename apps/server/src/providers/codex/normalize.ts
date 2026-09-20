import type { ProviderEvent, ProviderOutput } from '@agentdeck/shared';
import { summarizeToolInput } from '../summary';
import type { ServerNotification } from './schema';
import type { ThreadItem } from './schema/v2';

// app-server 通知 → 统一事件。只显式映射 §7.2 需要的子集，其余（含 reasoning / 命令输出 delta）直接丢弃（AGENTS.md 规则 5）。
// 一个 normalizer 实例对应一个 thread：需要跨通知记住正在流式输出的 agentMessage。
export function createNormalizer() {
  let streaming: { id: string; text: string } | null = null;
  let lastUsage = '';
  let lastContext = 0;

  function normalize(n: ServerNotification): ProviderOutput[] {
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
        return [{ type: 'message.delta', messageId: n.params.itemId, text: n.params.delta }];

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

      case 'thread/tokenUsage/updated': {
        // inputTokens 已含 cachedInputTokens，就是最近一次调用的 prompt 大小
        const context = n.params.tokenUsage.last.inputTokens;
        if (context === lastContext) return [];
        lastContext = context;
        return [{ type: 'context.updated', payload: { tokens: context } }];
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

      default:
        return [];
    }
  }

  return { normalize };
}

// 工具类 item：commandExecution / fileChange / mcpToolCall 各开一张工具卡，只记做了什么，不记输出 / diff（改动侧栏另有 git diff）
function itemStarted(item: ThreadItem): ProviderEvent[] {
  switch (item.type) {
    case 'commandExecution':
      return [{ type: 'tool.started', payload: { toolUseId: item.id, name: 'shell', summary: stripShellWrapper(item.command) } }];
    case 'fileChange':
      return [{ type: 'tool.started', payload: { toolUseId: item.id, name: 'apply_patch', summary: item.changes.map((c) => `${c.kind} ${c.path}`).join(', ') } }];
    case 'mcpToolCall':
      return [{ type: 'tool.started', payload: { toolUseId: item.id, name: `${item.server}/${item.tool}`, summary: summarizeToolInput(item.arguments) } }];
    default:
      return [];
  }
}

function itemCompleted(item: ThreadItem): ProviderEvent[] {
  switch (item.type) {
    case 'commandExecution':
    case 'fileChange':
      return [{ type: 'tool.completed', payload: { toolUseId: item.id, isError: item.status !== 'completed' } }];
    case 'mcpToolCall':
      return [{ type: 'tool.completed', payload: { toolUseId: item.id, isError: item.error !== null } }];
    default:
      return [];
  }
}

// Codex 把命令包成 `/bin/zsh -lc '<cmd>'`，卡片只展示用户能读的那部分
export function stripShellWrapper(command: string): string {
  const m = /^\S+ -lc '([\s\S]*)'$/.exec(command);
  return m ? m[1].replace(/'\\''/g, "'") : command;
}
