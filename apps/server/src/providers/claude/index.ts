import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ProviderEvent } from '@agentdeck/shared';
import { createNormalizer } from './normalize';

export type ClaudeSession = {
  send(text: string): void;
  close(): void;
};

type StartOptions = {
  cwd: string;
  onEvent(event: ProviderEvent): void;
  /** 子进程结束（正常关闭或抛错）后调用一次 */
  onExit(error?: unknown): void;
};

// 一个 Streaming Input 长驻 session（方案 §6.1）。消息通过 inbox 推入，SDK 消息经 normalizer 转成统一事件回调出去。
export function startClaudeSession({ cwd, onEvent, onExit }: StartOptions): ClaudeSession {
  const inbox = createInbox();
  const normalize = createNormalizer();

  const q = query({
    prompt: inbox,
    options: {
      cwd,
      env: childEnv(),
      permissionMode: 'default',
      includePartialMessages: true,
      // 只加载工作区的 project 设置：本机 user 设置是 bypassPermissions，会让审批静默通过（AGENTS.md 规则 2）
      settingSources: ['project'],
    },
  });

  (async () => {
    try {
      for await (const m of q) {
        if (m.type === 'system' && m.subtype === 'init' && m.permissionMode !== 'default') {
          onEvent({ type: 'error', payload: { message: `工作区 settings 把 permissionMode 改成了 ${m.permissionMode}，Hub 只接受 default，已拒绝启动` } });
          inbox.close();
          return;
        }
        for (const e of normalize(m)) onEvent(e);
      }
      onExit();
    } catch (err) {
      onExit(err);
    }
  })();

  return {
    send(text) {
      inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
    },
    close() {
      inbox.close();
    },
  };
}

// 子进程环境：去掉 CLAUDE* 避免被识别为嵌套 Claude Code 会话；去掉 API Key，复用本机 claude.ai 登录（AGENTS.md 规则 4）
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^CLAUDE/.test(k) && k !== 'ANTHROPIC_API_KEY') env[k] = v;
  }
  return env;
}

// 可从外部 push 的 AsyncIterable，SDK 在这个流上等待下一条用户消息
function createInbox() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(m: SDKUserMessage) {
      queue.push(m);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        if (closed) return;
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
    },
  };
}
