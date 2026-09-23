import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { AgentEvent } from '@agentdeck/shared';
import { HubError, type createHub } from './hub';
import type { Store } from './store/db';
import type { AgentdeckMcp } from './providers/types';

// 会话编排 MCP：只给 Hub 自己拉起的 Provider 会话用，调用方靠按会话注入的请求头识别（外部客户端不支持，没有会话可挂派生审批卡）。
// 请求头不是安全边界：REST 本身无鉴权，bypass 会话照样能 curl。派生审批拦的是 Agent 经由这个工具自主派生。

type Hub = ReturnType<typeof createHub>;

const callerHeader = 'x-agentdeck-session';
// 派生要等人审批，可能挂很久；超时由 Provider 侧断开请求，审批卡随之作废
const toolTimeoutSec = 24 * 3600;
const maxWaitSec = 600;
const maxEntries = 40;

/** Provider 侧免审批的工具：只读的，以及 create_session（它由 Hub 自己弹审批卡，不再让 Provider 先审一次） */
const autoApprove = ['list_workspaces', 'list_sessions', 'get_session', 'create_session'];

export function agentdeckMcpFor(url: string, sessionId: string): AgentdeckMcp {
  return { url, headers: { [callerHeader]: sessionId }, timeoutSec: toolTimeoutSec, autoApprove };
}

export function registerMcpRoute(app: FastifyInstance, hub: Hub, store: Store) {
  app.post('/mcp', async (req, reply) => {
    const callerId = req.headers[callerHeader];
    if (typeof callerId !== 'string' || !store.getSession(callerId)) return reply.code(403).send({ message: 'AgentDeck MCP is only available to AgentDeck sessions' });
    // 调用方断开（工具超时、轮被中断）时作废还在等的审批 / 等待
    const controller = new AbortController();
    reply.raw.on('close', () => controller.abort());
    const server = createMcpServer(hub, store, callerId, controller.signal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on('close', () => void server.close());
    reply.hijack();
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  // 无状态模式没有服务端推送流，也没有会话可删
  app.get('/mcp', (_req, reply) => reply.code(405).send({ message: 'Method Not Allowed' }));
  app.delete('/mcp', (_req, reply) => reply.code(405).send({ message: 'Method Not Allowed' }));
}

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });

export function createMcpServer(hub: Hub, store: Store, callerId: string, signal: AbortSignal): McpServer {
  const server = new McpServer({ name: 'agentdeck', version: '0.0.0' });
  const notSelf = (id: string) => {
    if (id === callerId) throw new HubError(400, 'This is your own session; target another session');
  };

  server.registerTool('list_workspaces', {
    description: 'List AgentDeck projects. New sessions can only be created in one of these paths.',
    inputSchema: {},
  }, () => json(store.listWorkspaces().map((w) => ({ path: w.path, alias: w.alias }))));

  server.registerTool('list_sessions', {
    description: 'List AgentDeck sessions, most recently updated first (at most 50). Your own session is marked self: true.',
    inputSchema: {
      workspace: z.string().optional().describe('Only sessions in this project path'),
      status: z.enum(['idle', 'running', 'waiting_user', 'error']).optional(),
    },
  }, ({ workspace, status }) => json(hub.listSessions()
    .filter((s) => (!workspace || s.cwd === workspace) && (!status || s.status === status))
    .slice(0, 50)
    .map((s) => ({ id: s.id, provider: s.provider, workspace: s.cwd, title: s.title, status: s.status, archived: !!s.archivedAt, updatedAt: s.updatedAt, ...(s.id === callerId ? { self: true } : {}) }))));

  server.registerTool('create_session', {
    description: 'Start a new AgentDeck session and send it a first message. The user must approve this in AgentDeck; the call blocks until they do. Model, effort and permission mode come from AgentDeck settings. Returns the new session id; follow it with get_session.',
    inputSchema: {
      provider: z.enum(['claude', 'codex', 'deepseek']),
      prompt: z.string().min(1).describe('First message for the new session'),
      workspace: z.string().optional().describe('Project path from list_workspaces; defaults to your own project'),
      notify: z.boolean().optional().describe('Default true: when the session finishes this work, its result arrives in your conversation as a new message, so end your turn instead of waiting. Set false only if you need the result within this turn, then use get_session with waitSec'),
    },
  }, async ({ provider, prompt, workspace, notify = true }) => {
    const cwd = workspace ?? hub.getSession(callerId).cwd;
    // 先校验再弹卡，不让人批一张注定失败的请求
    if (!store.getWorkspaceByPath(cwd)) throw new HubError(400, `${cwd} is not an AgentDeck project; see list_workspaces`);
    const resolution = await hub.createPending(callerId, {
      kind: 'approval', toolName: 'AgentDeck: create session', toolUseId: randomUUID(), input: { provider, workspace: cwd, prompt },
      description: 'Start a new session with the default model and permission mode from Settings',
      sessionAllowPatterns: [], suggestions: [],
    }, signal);
    if (resolution?.kind !== 'approval' || resolution.decision === 'deny') throw new HubError(403, 'The user did not approve creating the session');
    signal.throwIfAborted();
    const session = hub.createSession(provider, cwd);
    try {
      hub.sendMessage(session.id, prompt, [], 'agent');
    } catch (error) {
      // 消息尚未入库时恢复为审批前状态，避免留下无法使用的空会话（如 DeepSeek 缺少 Key）。
      if (hub.lastSeq(session.id) === 0) hub.deleteSession(session.id);
      throw error;
    }
    if (notify) hub.notifyWhenDone(session.id, callerId);
    return json({ sessionId: session.id });
  });

  server.registerTool('get_session', {
    description: `Read a session: status, open approvals / questions, and conversation entries (user and assistant messages, one-line tool summaries) after afterSeq, at most ${maxEntries} latest. Pass nextSeq from the previous call as afterSeq to read only new entries. With waitSec, first waits until the session stops running (idle, error, or waiting for the user) or the time runs out; prefer the notify option of create_session / send_message over waiting.`,
    inputSchema: {
      id: z.string(),
      afterSeq: z.number().int().min(0).optional(),
      waitSec: z.number().int().min(0).max(maxWaitSec).optional(),
    },
  }, async ({ id, afterSeq = 0, waitSec = 0 }) => {
    const session = hub.getSession(id);
    if (waitSec > 0) {
      notSelf(id);
      if (session.status === 'running') await waitWhileRunning(hub, id, waitSec, signal);
    }
    const entries = hub.eventsAfter(id, afterSeq).flatMap(toEntry);
    return json({
      status: hub.getSession(id).status,
      pending: hub.pendingRequests(id).map((p) => p.kind === 'approval'
        ? { kind: 'approval', tool: p.toolName, input: p.input }
        : { kind: 'question', questions: p.questions.map((q) => q.question) }),
      nextSeq: hub.lastSeq(id),
      ...(entries.length > maxEntries ? { truncated: true } : {}),
      entries: entries.slice(-maxEntries),
    });
  });

  server.registerTool('send_message', {
    description: 'Send a message to another session. If it is running, the message is queued and sent after the current turn.',
    inputSchema: {
      id: z.string(),
      text: z.string().min(1),
      notify: z.boolean().optional().describe('Default true: when the session finishes this work, its result arrives in your conversation as a new message, so end your turn instead of waiting. Set false only if you need the result within this turn, then use get_session with waitSec'),
    },
  }, ({ id, text, notify = true }) => {
    notSelf(id);
    const result = hub.sendMessage(id, text, [], 'agent');
    if (notify) hub.notifyWhenDone(id, callerId);
    return json(result);
  });

  server.registerTool('interrupt', {
    description: 'Stop the running turn of another session; queued messages are dropped.',
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    notSelf(id);
    await hub.interrupt(id);
    return json({ ok: true });
  });

  return server;
}

// 只给调用方看对话本身：状态切换、额度、审批往返这些 UI 事件不占它的上下文
function toEntry(e: AgentEvent): Record<string, unknown>[] {
  switch (e.type) {
    case 'message.user': return [{ seq: e.seq, role: 'user', text: e.payload.text }];
    case 'message.completed': return [{ seq: e.seq, role: 'assistant', text: e.payload.text }];
    case 'tool.started': return [{ seq: e.seq, tool: e.payload.name, summary: e.payload.summary }];
    case 'turn.completed': return e.payload.reason === 'interrupted' ? [{ seq: e.seq, turn: 'interrupted' }] : [];
    case 'turn.failed':
    case 'error': return [{ seq: e.seq, error: e.payload.message }];
    default: return [];
  }
}

function waitWhileRunning(hub: Hub, id: string, waitSec: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(done, waitSec * 1000);
    signal.addEventListener('abort', done, { once: true });
    const unsubscribe = hub.subscribe(id, (m) => {
      if (m.type === 'event' && m.event.type === 'session.status' && m.event.payload.status !== 'running') done();
    }, done);
  });
}
