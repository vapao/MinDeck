import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { effortOptions, modelOptions, type AgentEvent } from '@agentdeck/shared';
import { HubError, type createHub } from './hub';
import type { Store } from './store/db';
import type { Services } from './services';
import type { AgentdeckMcp } from './providers/types';

// 会话编排 MCP：只给 Hub 自己拉起的 Provider 会话用，调用方靠按会话注入的请求头识别（外部客户端不支持，没有会话可挂派生审批卡）。
// 请求头不是安全边界：REST 本身无鉴权，bypass 会话照样能 curl。派生审批拦的是 Agent 经由这个工具自主派生。

type Hub = ReturnType<typeof createHub>;

const callerHeader = 'x-agentdeck-session';
// 派生要等人审批，可能挂很久；超时由 Provider 侧断开请求，审批卡随之作废
const toolTimeoutSec = 24 * 3600;
const maxWaitSec = 600;
const maxEntries = 40;
const defaultLogLines = 100;
const maxLogLines = 1000;

/** Provider 侧免审批的工具：只读的，create_session（它由 Hub 自己弹审批卡，不再让 Provider 先审一次），以及只影响自己会话的 compact_after_turn */
const autoApprove = ['list_workspaces', 'list_sessions', 'get_session', 'create_session', 'list_services', 'get_service_log', 'compact_after_turn'];

export function agentdeckMcpFor(url: string, sessionId: string): AgentdeckMcp {
  return { url, headers: { [callerHeader]: sessionId }, timeoutSec: toolTimeoutSec, autoApprove };
}

export function registerMcpRoute(app: FastifyInstance, hub: Hub, store: Store, services: Services) {
  app.post('/mcp', async (req, reply) => {
    const callerId = req.headers[callerHeader];
    if (typeof callerId !== 'string' || !store.getSession(callerId)) return reply.code(403).send({ message: 'AgentDeck MCP is only available to AgentDeck sessions' });
    // 调用方断开（工具超时、轮被中断）时作废还在等的审批 / 等待
    const controller = new AbortController();
    reply.raw.on('close', () => controller.abort());
    const server = createMcpServer(hub, store, services, callerId, controller.signal);
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

export function createMcpServer(hub: Hub, store: Store, services: Services, callerId: string, signal: AbortSignal): McpServer {
  const server = new McpServer({ name: 'agentdeck', version: '0.0.0' });
  const notSelf = (id: string) => {
    if (id === callerId) throw new HubError(400, 'This is your own session; target another session');
  };
  const project = (path?: string) => {
    const cwd = path ?? hub.getSession(callerId).cwd;
    const workspace = store.getWorkspaceByPath(cwd);
    if (!workspace) throw new HubError(400, `${cwd} is not an AgentDeck project; see list_workspaces`);
    return workspace;
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
    description: 'Delegate a task to a new AgentDeck session. Write the prompt as a handoff brief built from this conversation: the goal, the plan and decisions already agreed, scope boundaries, and open questions. Do not investigate the repository to write the prompt; the new session explores on its own. Do not restate project rules from AGENTS.md / CLAUDE.md; the new session loads them. Do not add work the user did not ask for. The user must approve in AgentDeck (unless they already allowed it for this session); the call blocks until they do. Model and effort default to AgentDeck settings; permission mode always does. Returns the new session id.',
    inputSchema: {
      provider: z.enum(['claude', 'codex', 'deepseek']),
      prompt: z.string().min(1).describe('First message for the new session'),
      workspace: z.string().optional().describe('Project path from list_workspaces; defaults to your own project'),
      model: z.string().optional().describe(`Only when the user asked for a specific model; defaults to AgentDeck settings. ${Object.entries(modelOptions).map(([p, options]) => `${p}: ${options.map((o) => o.value).join(', ')}`).join('; ')}`),
      effort: z.string().optional().describe(`Only when the user asked for a specific thinking effort; defaults to AgentDeck settings. claude: ${effortOptions.claude.map((o) => o.value).join(', ')}; codex: ${effortOptions.codex.map((o) => o.value).join(', ')} (ultra not on every model); deepseek: none`),
      notify: z.boolean().optional().describe('Default false. Set true only when you need the result to continue your own work (e.g. the user asked you to compare, summarize, or build on it); the result then arrives later as a new message. Either way, do not wait or poll for the session — carry on with any remaining work.'),
    },
  }, async ({ provider, prompt, workspace, model, effort, notify = false }) => {
    const cwd = workspace ?? hub.getSession(callerId).cwd;
    // 先校验再弹卡，不让人批一张注定失败的请求
    if (!store.getWorkspaceByPath(cwd)) throw new HubError(400, `${cwd} is not an AgentDeck project; see list_workspaces`);
    if (provider === 'deepseek' && !hub.settings().deepseek.apiKeyConfigured) throw new HubError(400, 'DeepSeek API Key is not configured in AgentDeck settings');
    // 解析成具体值再上审批卡：批准的就是实际要用的，审批期间改设置也不会换掉
    const config = hub.resolveSessionConfig(provider, { model, effort });
    if (!hub.canSpawn(callerId)) {
      const resolution = await hub.createPending(callerId, {
        kind: 'approval', toolName: 'AgentDeck: create session', toolUseId: randomUUID(), input: { provider, workspace: cwd, model: config.model ?? 'Default', effort: config.effort ?? 'Default', prompt },
        description: 'Start a new session with the permission mode from Settings',
        sessionAllowPatterns: ['create_session'], suggestions: [],
      }, signal);
      if (resolution?.kind !== 'approval' || resolution.decision === 'deny') throw new HubError(403, 'The user did not approve creating the session');
      if (resolution.decision === 'allow_session') hub.setSpawnGranted(callerId, true);
      signal.throwIfAborted();
    }
    const session = hub.createSession(provider, cwd, { model: config.model ?? '', effort: config.effort ?? '', parentId: callerId });
    try {
      hub.sendMessage(session.id, prompt, [], 'agent');
    } catch (error) {
      // 审批期间设置被改（如清掉 DeepSeek Key）导致首条消息发不出：删掉刚建的空会话，不留无法使用的会话
      if (hub.lastSeq(session.id) === 0) hub.deleteSession(session.id);
      throw error;
    }
    if (notify) hub.notifyWhenDone(session.id, callerId);
    return json({ sessionId: session.id });
  });

  server.registerTool('get_session', {
    description: `Read a session: status, open approvals / questions, and conversation entries (user and assistant messages, errors, and interruptions; no tool calls) after afterSeq, at most ${maxEntries} latest. A reference like #[title](session:ID) identifies a session; use that ID directly without looking it up by title. Pass nextSeq from the previous call as afterSeq to read only new entries. With waitSec, first waits until the session stops running (idle, error, or waiting for the user) or the time runs out; prefer the notify option of create_session / send_message over waiting.`,
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
    description: 'Send a message to another session. If it is running, the message is delivered into the current turn and takes effect at its next step.',
    inputSchema: {
      id: z.string(),
      text: z.string().min(1),
      notify: z.boolean().optional().describe('Default false. Set true only when you need the result to continue your own work (e.g. the user asked you to compare, summarize, or build on it); the result then arrives later as a new message. Either way, do not wait or poll for the session — carry on with any remaining work.'),
    },
  }, ({ id, text, notify = false }) => {
    notSelf(id);
    const result = hub.sendMessage(id, text, [], 'agent');
    if (notify) hub.notifyWhenDone(id, callerId);
    return json(result);
  });

  server.registerTool('move_session', {
    description: 'Move a session under another parent session, or to the top level when parent is omitted. To split off a separate line of work: create_session for it (its brief names the sessions it will take over and that their results will come to it), move it to the top level, then move those sessions under it. A result its old parent was waiting for (notify) goes to the new parent instead, or is dropped at the top level.',
    inputSchema: {
      id: z.string(),
      parent: z.string().optional().describe('New parent session id; omit to make it a top-level session'),
    },
  }, ({ id, parent }) => {
    const session = hub.moveSession(id, parent ?? null);
    return json({ id: session.id, parentId: session.parentId });
  });

  server.registerTool('compact_after_turn', {
    description: 'Compact your own conversation context once your current turn ends, to drop exploration that is no longer needed. End your turn right after calling this. Results of sessions you are notified about that arrive during compaction are delivered after it. Claude and DeepSeek sessions only.',
    inputSchema: {
      instructions: z.string().min(1).describe('What the summary must keep verbatim (e.g. session IDs you will message later, the original request, decisions, changed files, pending steps) and what it may drop'),
      continueWith: z.string().min(1).optional().describe('Message sent to you right after compaction so you resume on your own, e.g. the next step to take. Omit it when a notified sub-session or the user will wake you'),
    },
  }, ({ instructions, continueWith }) => {
    hub.compactAfterTurn(callerId, instructions, continueWith);
    return json({ scheduled: true });
  });

  server.registerTool('interrupt', {
    description: 'Stop the running turn of another session; messages it has not picked up yet are dropped.',
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    notSelf(id);
    await hub.interrupt(id);
    return json({ ok: true });
  });

  server.registerTool('list_services', {
    description: 'List development services in an AgentDeck project, including their ids, commands, working subdirectories, links, and running state.',
    inputSchema: { workspace: z.string().optional().describe('Project path from list_workspaces; defaults to your own project') },
  }, ({ workspace }) => {
    const { id } = project(workspace);
    return json(services.list().filter((s) => s.workspaceId === id)
      .map(({ id, name, command, subdir, url, running }) => ({ id, name, command, subdir, url, running })));
  });

  server.registerTool('create_service', {
    description: 'Create a development service configuration without starting it. First call list_services; if a similar service exists, update it instead of creating a duplicate.',
    inputSchema: {
      name: z.string().min(1),
      command: z.string().min(1),
      subdir: z.string().optional().describe('Working directory relative to the project root; defaults to the root'),
      url: z.string().optional().describe('Link to display in AgentDeck; defaults to empty'),
      workspace: z.string().optional().describe('Project path from list_workspaces; defaults to your own project'),
    },
  }, ({ name, command, subdir = '', url = '', workspace }) => json(services.create({ workspaceId: project(workspace).id, name, command, subdir, url })));

  server.registerTool('update_service', {
    description: 'Update only the supplied fields of a service configuration. Changes to a running service take effect after restart_service.',
    inputSchema: {
      id: z.string(),
      name: z.string().min(1).optional(),
      command: z.string().min(1).optional(),
      subdir: z.string().optional(),
      url: z.string().optional(),
    },
  }, ({ id, name, command, subdir, url }) => {
    const current = services.list().find((s) => s.id === id);
    if (!current) throw new HubError(404, 'Service not found');
    return json(services.update(id, {
      name: name ?? current.name,
      command: command ?? current.command,
      subdir: subdir ?? current.subdir,
      url: url ?? current.url,
    }));
  });

  for (const action of ['start', 'stop', 'restart'] as const) {
    server.registerTool(`${action}_service`, {
      description: action === 'start'
        ? 'Start a service and return immediately, without waiting for readiness. Use get_service_log to inspect its output.'
        : `${action === 'stop' ? 'Stop' : 'Restart'} a service.`,
      inputSchema: { id: z.string() },
    }, async ({ id }) => {
      await services[action](id);
      return json({ ok: true });
    });
  }

  server.registerTool('get_service_log', {
    description: `Read a service log. Without cursor, return the last N lines (default ${defaultLogLines}, max ${maxLogLines}) and mark truncated when earlier output was omitted. Pass the returned cursor to read only new output; a restarted service resets the cursor and returns its latest lines.`,
    inputSchema: {
      id: z.string(),
      cursor: z.string().optional().describe('Opaque cursor returned by the previous call'),
      lines: z.number().int().min(1).max(maxLogLines).optional().describe('Number of tail lines on the first read; default 100, max 1000'),
    },
  }, ({ id, cursor, lines = defaultLogLines }) => {
    const log = services.log(id, cursor);
    if (cursor && !log.reset) return json({ ...log, truncated: false });
    const parts = log.text ? log.text.split('\n') : [];
    const trailingNewline = parts.at(-1) === '';
    if (trailingNewline) parts.pop();
    // services.log 首次只读末尾 64KB；即使不足 N 行，之前的字节也应标为截断。
    const byteOffset = Number(log.cursor.slice(log.cursor.lastIndexOf(':') + 1));
    const truncated = parts.length > lines || (log.reset && byteOffset > 64 * 1024);
    return json({ ...log, text: parts.slice(-lines).join('\n') + (trailingNewline ? '\n' : ''), truncated });
  });

  return server;
}

// 只给调用方看对话本身：状态切换、额度、审批往返这些 UI 事件不占它的上下文
function toEntry(e: AgentEvent): Record<string, unknown>[] {
  switch (e.type) {
    case 'message.user': return [{ seq: e.seq, role: 'user', text: e.payload.text }];
    case 'message.completed': return [{ seq: e.seq, role: 'assistant', text: e.payload.text }];
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
