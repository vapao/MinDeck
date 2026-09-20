import { readFileSync } from 'node:fs';
import { query, type CanUseTool, type EffortLevel, type PermissionResult, type PermissionUpdate, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QuestionSpec } from '@agentdeck/shared';
import type { ProviderSession, StartOptions } from '../types';
import { createNormalizer } from './normalize';

// 一个 Streaming Input 长驻 session（方案 §6.1）。消息通过 inbox 推入，SDK 消息经 normalizer 转成统一事件回调出去。
export function startClaudeSession({ cwd, resume, model, effort, permissionMode, onEvent, onPending, onExit }: StartOptions): ProviderSession {
  // bypass：会话级选了"完全跳过审批"（AgentDeck 设置里配的，不是本机 ~/.claude/settings.json 那份）
  const sdkPermissionMode = permissionMode === 'bypass' ? 'bypassPermissions' : 'default';
  const inbox = createInbox();
  const { normalize, markInterrupting } = createNormalizer(resume !== undefined);

  // 审批与 AskUserQuestion 都从这里进来（方案 §6.4）；AskUserQuestion 的回答通过 updatedInput.answers 交还
  const canUseTool: CanUseTool = async (toolName, input, { signal, suggestions = [], toolUseID, title, description, decisionReason }) => {
    if (toolName === 'AskUserQuestion') {
      const questions = input.questions as QuestionSpec[];
      const r = await onPending({ kind: 'question', toolUseId: toolUseID, questions }, signal);
      if (r?.kind !== 'question') return deny();
      const answers = Object.fromEntries(Object.entries(r.answers).map(([q, labels]) => [q, labels.join(', ')]));
      return { behavior: 'allow', updatedInput: { questions, answers, ...(r.response ? { response: r.response } : {}) } };
    }
    const r = await onPending(
      { kind: 'approval', toolName, toolUseId: toolUseID, input, title, description, decisionReason, sessionAllowPatterns: describeRules(suggestions), suggestions },
      signal,
    );
    if (r?.kind !== 'approval' || r.decision === 'deny') return deny();
    return {
      behavior: 'allow',
      updatedInput: input,
      // "本会话允许"只写 session 级规则，不落到本机 settings 文件
      ...(r.decision === 'allow_session' ? { updatedPermissions: suggestions.map((s) => ({ ...s, destination: 'session' as const })) } : {}),
    };
  };

  const q = query({
    prompt: inbox,
    options: {
      cwd,
      resume,
      model,
      // effort 只能在这里给，SDK 没有会话中的 setter；取值已由 Hub 按 shared effortOptions 校验
      effort: effort as EffortLevel | undefined,
      env: childEnv(),
      permissionMode: sdkPermissionMode,
      // 不设 systemPrompt 时 SDK 只给"最小提示词"，跟 CLI 不一样；用 preset 对齐
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      includePartialMessages: true,
      // 加载 user 是为了拿 ~/.claude/CLAUDE.md、个人 skill 和插件；但本机 settings.json 的 defaultMode 是 bypassPermissions，
      // 会压过 permissionMode 选项，所以用 flag 层（最高优先级）把它按会话强制回来，并在 init 回包里复核（AGENTS.md 规则 2）
      settingSources: ['user', 'project'],
      settings: { permissions: { defaultMode: sdkPermissionMode } },
      canUseTool,
    },
  });

  (async () => {
    try {
      for await (const m of q) {
        if (m.type === 'system' && m.subtype === 'init' && m.permissionMode !== sdkPermissionMode) {
          onEvent({ type: 'error', payload: { message: `settings changed permissionMode to ${m.permissionMode}, but the Hub requires ${sdkPermissionMode}; refusing to start` } });
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
    send({ text, images }) {
      // 原生 image block（方案 §9.1）；图片放在文字前面是 Anthropic 视觉文档的建议顺序
      const content: SDKUserMessage['message']['content'] = [
        ...images.map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mimeType, data: readFileSync(img.path).toString('base64') } })),
        ...(text ? [{ type: 'text' as const, text }] : []),
      ];
      inbox.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
    },
    // SDK 随后以 error_during_execution 结束该轮，normalizer 映射为 reason: 'interrupted'
    async interrupt() {
      markInterrupting();
      await q.interrupt();
    },
    close() {
      inbox.close();
    },
  };
}

const deny = (): PermissionResult => ({ behavior: 'deny', message: 'The user denied this action in AgentDeck' });

// 把 Provider 建议的规则压成 UI 可读的 pattern，例如 Bash(git status:*)
function describeRules(suggestions: PermissionUpdate[]): string[] {
  return suggestions.flatMap((s) =>
    s.type === 'addRules' || s.type === 'replaceRules'
      ? s.rules.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName))
      : [],
  );
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
