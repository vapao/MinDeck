import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { forkSession, importSessionToStore, query, type CanUseTool, type EffortLevel, type PermissionResult, type PermissionUpdate, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { skillToken, type QuestionSpec } from '@mindeck/shared';
import type { ProviderSession, StartOptions } from '../types';
import { createNormalizer } from './normalize';

// 一个 Streaming Input 长驻 session（方案 §6.1）。消息通过 inbox 推入，SDK 消息经 normalizer 转成统一事件回调出去。
export function startClaudeSession({ cwd, resume, model, effort, permissionMode, deepseek, mindeckMcp, onEvent, onPending, onExit }: StartOptions): ProviderSession {
  // bypass：会话级选了"完全跳过审批"（MinDeck 设置里配的，不是本机 ~/.claude/settings.json 那份）
  const sdkPermissionMode = permissionMode === 'bypass' ? 'bypassPermissions' : 'default';
  const connectionEnv = deepseek ? deepseekEnv(deepseek, model ?? 'deepseek-flash') : undefined;
  const inbox = createInbox();
  const { normalize, markInterrupting } = createNormalizer(resume !== undefined);

  // 审批与 AskUserQuestion 都从这里进来（方案 §6.4）；AskUserQuestion 的回答通过 updatedInput.answers 交还
  const canUseTool: CanUseTool = async (toolName, input, { signal, suggestions = [], toolUseID, title, description, decisionReason }) => {
    // 放在这里而不是 allowedTools：后者会让 SDK 对每个会话打一条 canUseTool 被遮蔽的警告
    if (mindeckMcp.autoApprove.some((t) => toolName === `mcp__mindeck__${t}`)) return { behavior: 'allow', updatedInput: input };
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
      model: deepseek ? `${model ?? 'deepseek-flash'}[1m]` : model,
      // effort 只能在这里给，SDK 没有会话中的 setter；取值已由 Hub 按 shared effortOptions 校验
      effort: effort as EffortLevel | undefined,
      // session_state_changed: idle 是"插入的消息全部处理完"的唯一可靠信号（一轮里插入的消息可能被并入该轮，也可能在其后自成一轮）
      env: { ...childEnv(), ...connectionEnv, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
      permissionMode: sdkPermissionMode,
      // 不设 systemPrompt 时 SDK 只给"最小提示词"，跟 CLI 不一样；用 preset 对齐。
      // append：Claude 习惯把截图等输出文件写成行内代码路径，前端只把 Markdown 图片 / 链接渲染成可预览的文件
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: 'Your replies are rendered as Markdown in a web UI that can display local files. When you mention a local image you produced or want the user to look at (screenshots, charts), embed it with `![name](/absolute/path.png)`; link other output files as `[name](/absolute/path)`. Do not put these file paths in backticks.',
      },
      includePartialMessages: true,
      // 加载 user 是为了拿 ~/.claude/CLAUDE.md、个人 skill 和插件；但本机 settings.json 的 defaultMode 是 bypassPermissions，
      // 会压过 permissionMode 选项，所以用 flag 层（最高优先级）把它按会话强制回来，并在 init 回包里复核（AGENTS.md 规则 2）
      settingSources: ['user', 'project'],
      settings: { permissions: { defaultMode: sdkPermissionMode }, ...(connectionEnv ? { env: connectionEnv } : {}) },
      mcpServers: { mindeck: { type: 'http', url: mindeckMcp.url, headers: mindeckMcp.headers, timeout: mindeckMcp.timeoutSec * 1000, alwaysLoad: true } },
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
        for (const e of normalize(m)) {
          // DeepSeek 不提供 Claude 订阅额度，不能污染官方 Claude 的额度条。
          if (deepseek && e.type === 'usage.updated') continue;
          onEvent(e);
        }
      }
      onExit();
    } catch (err) {
      onExit(err);
    }
  })();

  // 开头是 $skill 的消息要先异步查 skill 列表，之后的消息排在它后面保持顺序；interrupt 让还没推进去的作废
  let sending = Promise.resolve();
  let epoch = 0;

  return {
    send({ text, images }) {
      // 原生 image block（方案 §9.1）；图片放在文字前面是 Anthropic 视觉文档的建议顺序
      const imageBlocks = images.map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mimeType, data: readFileSync(img.path).toString('base64') } }));
      const skill = skillToken(text);
      const sentAt = epoch;
      sending = sending
        .then(async () => {
          // 界面统一用 $ 触发 skill，SDK 只认消息开头的 /name；不是已知 skill 的 $xxx 原样发
          const body = skill && (await reloadClaudeSkills(q)).some((s) => s.name === skill) ? `/${text.slice(1)}` : text;
          if (epoch !== sentAt) return;
          const content: SDKUserMessage['message']['content'] = [...imageBlocks, ...(body ? [{ type: 'text' as const, text: body }] : [])];
          // 一轮进行中 push 的消息由 SDK 在下一个工具边界并入当前轮；带 uuid 才能被 interrupt 的 cancelQueued 撤回
          inbox.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid: randomUUID() });
        })
        .catch((err: Error) => onEvent({ type: 'error', payload: { message: `Failed to resolve skill: ${err.message}` } }));
    },
    // SDK 随后以 error_during_execution 结束该轮，normalizer 映射为 reason: 'interrupted'。
    // cancelQueued 让还没并入的插入消息一起作废，否则中断后它们会自成一轮继续跑；运行时支持，但 SDK 类型没声明这个参数
    async interrupt() {
      epoch++;
      markInterrupting();
      await (q.interrupt as (options: { cancelQueued: boolean }) => ReturnType<typeof q.interrupt>)({ cancelQueued: true });
    },
    close() {
      inbox.close();
    },
  };
}

// 起进程列 skill 要 2 秒多，按 cwd 缓存：有缓存直接返回，超过 60 秒才在后台刷新，下次请求拿到新的。
// 同一 cwd 同时只跑一个刷新；失败的不进缓存，下次重试
type SkillList = Awaited<ReturnType<typeof fetchClaudeSkills>>;
const skillCache = new Map<string, { skills: SkillList; at: number }>();
const skillLoads = new Map<string, Promise<SkillList>>();
function loadClaudeSkills(cwd: string) {
  let load = skillLoads.get(cwd);
  if (!load) {
    load = fetchClaudeSkills(cwd)
      .then((skills) => {
        skillCache.set(cwd, { skills, at: Date.now() });
        return skills;
      })
      .finally(() => skillLoads.delete(cwd));
    skillLoads.set(cwd, load);
  }
  return load;
}

/** 列出 cwd 下的 skill（不含内置命令），DeepSeek 同用 */
export async function listClaudeSkills(cwd: string) {
  const cached = skillCache.get(cwd);
  if (!cached) return loadClaudeSkills(cwd);
  if (Date.now() - cached.at > 60_000) loadClaudeSkills(cwd).catch(() => {});
  return cached.skills;
}

export async function reloadClaudeSkills(q: Pick<Query, 'reloadSkills' | 'supportedCommands'>) {
  const { skills } = await q.reloadSkills();
  // reloadSkills 漏掉仅允许手动调用的 skill；补入用户命令，但不引入 /clear、/model 等内置命令。
  const commands = (await q.supportedCommands()).filter((s) => !s.builtin);
  return [...new Map([...skills, ...commands].map((s) => [s.name, s])).values()];
}

/** 起一个空的 Streaming Input 会话只发控制请求，不调模型 */
async function fetchClaudeSkills(cwd: string) {
  const q = query({ prompt: createInbox(), options: { cwd, env: childEnv(), settingSources: ['user', 'project'], systemPrompt: { type: 'preset', preset: 'claude_code' }, persistSession: false } });
  try {
    return await reloadClaudeSkills(q);
  } finally {
    q.close();
  }
}

/** 复制出一份截到 anchor（含）的新会话记录，返回新 session id；原记录不动（DeepSeek 同用） */
export async function forkClaudeSession(sessionId: string, anchor: string, cwd: string): Promise<string> {
  const upToMessageId = await resolveAnchor(sessionId, anchor, cwd);
  if (!upToMessageId) throw new Error(`Fork point ${anchor} not found in session ${sessionId} or the sessions it was forked from`);
  return (await forkSession(sessionId, { dir: cwd, upToMessageId })).sessionId;
}

// SDK 分叉时给每条消息换新 uuid（原 uuid 记在 forkedFrom），Hub 复制过来的旧轮锚点仍是祖先会话的 uuid，沿 forkedFrom 链换回本会话的
async function resolveAnchor(sessionId: string, anchor: string, cwd: string): Promise<string | undefined> {
  const entries: Array<{ uuid?: string; forkedFrom?: { sessionId: string; messageUuid: string } }> = [];
  await importSessionToStore(sessionId, { append: async (_key, batch) => void entries.push(...batch), load: async () => null }, { dir: cwd, includeSubagents: false });
  if (entries.some((e) => e.uuid === anchor)) return anchor;
  const parent = entries.find((e) => e.forkedFrom)?.forkedFrom?.sessionId;
  const inParent = parent && (await resolveAnchor(parent, anchor, cwd));
  return inParent ? entries.find((e) => e.forkedFrom?.messageUuid === inParent)?.uuid : undefined;
}

// 最小连通验证：与会话共用环境注入，经真实 SDK 请求，但不运行工具或保存测试会话。
export async function verifyDeepseekConnection(cwd: string, connection: { baseUrl: string; apiKey: string }, model: string) {
  const env = deepseekEnv(connection, model);
  const abortController = new AbortController();
  const q = query({
    prompt: 'Reply with OK only. Do not use tools.',
    options: {
      cwd, model: `${model}[1m]`, env: { ...childEnv(), ...env },
      settingSources: ['user', 'project'],
      settings: { env, permissions: { defaultMode: 'default' } },
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      permissionMode: 'default', tools: [], maxTurns: 1, persistSession: false, abortController,
    },
  });
  const timeout = setTimeout(() => abortController.abort(), 60_000);
  try {
    for await (const m of q) {
      if (m.type !== 'result') continue;
      if (m.subtype !== 'success') throw new Error(m.errors.join('\n') || m.subtype);
      return { baseUrl: connection.baseUrl, model };
    }
    throw new Error('DeepSeek 未返回结果');
  } finally {
    clearTimeout(timeout);
    q.close();
  }
}

const deny = (): PermissionResult => ({ behavior: 'deny', message: 'The user denied this action in MinDeck' });

// 把 Provider 建议的规则压成 UI 可读的 pattern，例如 Bash(git status:*)
function describeRules(suggestions: PermissionUpdate[]): string[] {
  return suggestions.flatMap((s) =>
    s.type === 'addRules' || s.type === 'replaceRules'
      ? s.rules.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName))
      : [],
  );
}

// flag 层 env 同时覆盖 user/project settings，避免本机模型映射或认证改写 DeepSeek 会话。
export function deepseekEnv(connection: { baseUrl: string; apiKey: string }, model: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: connection.baseUrl,
    ANTHROPIC_AUTH_TOKEN: connection.apiKey,
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    CLAUDE_CODE_USE_BEDROCK: '',
    CLAUDE_CODE_USE_VERTEX: '',
    CLAUDE_CODE_USE_FOUNDRY: '',
    ANTHROPIC_MODEL: `${model}[1m]`,
    ANTHROPIC_DEFAULT_OPUS_MODEL: `${model}[1m]`,
    ANTHROPIC_DEFAULT_SONNET_MODEL: `${model}[1m]`,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_EFFORT_LEVEL: 'max',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432',
  };
}

// 子进程环境：去掉 CLAUDE* 避免被识别为嵌套 Claude Code 会话；去掉 API Key，复用本机 claude.ai 登录（AGENTS.md 规则 4）
export function childEnv(): Record<string, string> {
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
