import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import type { AgentEvent, ClientMessage, CreateSessionBody, ResolvePendingBody, SendMessageBody, ServerMessage } from '@agentdeck/shared';
import { openStore } from './store/db';
import { createHub, HubError } from './hub';

const repoRoot = resolve(import.meta.dirname, '../../..');
const port = Number(process.env.AGENTDECK_PORT ?? 8787);
const dbPath = process.env.AGENTDECK_DB ?? resolve(repoRoot, 'data/agentdeck.db');
// 工作区 allowlist（方案 §11.3）：逗号分隔的绝对路径；默认只允许本仓库
const workspaces = (process.env.AGENTDECK_WORKSPACES ?? repoRoot).split(',').map((p) => resolve(p));

mkdirSync(dirname(dbPath), { recursive: true });
const store = openStore(dbPath);
const hub = createHub(store, workspaces);

const app = Fastify({ logger: true });
await app.register(websocket);

app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  if (!(err instanceof HubError)) app.log.error(err);
  return reply.code(err.statusCode ?? 500).send({ message: err.message });
});

app.get('/api/workspaces', () => workspaces.map((cwd) => ({ cwd })));

app.post<{ Body: CreateSessionBody }>(
  '/api/sessions',
  { schema: { body: { type: 'object', required: ['provider', 'cwd'], properties: { provider: { type: 'string' }, cwd: { type: 'string' } } } } },
  (req, reply) => reply.code(201).send(hub.createSession(req.body.provider, req.body.cwd)),
);

app.post<{ Params: { id: string }; Body: SendMessageBody }>(
  '/api/sessions/:id/messages',
  { schema: { body: { type: 'object', required: ['text'], properties: { text: { type: 'string', minLength: 1 } } } } },
  (req, reply) => reply.code(202).send({ seq: hub.sendMessage(req.params.id, req.body.text) }),
);

app.post<{ Params: { id: string }; Body: ResolvePendingBody }>(
  '/api/pending/:id/resolve',
  { schema: { body: { type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: ['approval', 'question'] } } } } },
  (req) => ({ seq: hub.resolvePending(req.params.id, req.body) }),
);

app.get('/ws', { websocket: true }, (socket) => {
  const send = (m: ServerMessage) => socket.send(JSON.stringify(m));
  const subscriptions = new Map<string, () => void>();

  socket.on('message', (data: { toString(): string }) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return send({ type: 'error', code: 'bad_json', message: '消息不是合法 JSON' });
    }
    switch (msg.type) {
      case 'ping':
        return send({ type: 'pong' });
      case 'unsubscribe':
        subscriptions.get(msg.sessionId)?.();
        subscriptions.delete(msg.sessionId);
        return;
      case 'subscribe': {
        subscriptions.get(msg.sessionId)?.();
        let session;
        try {
          session = hub.getSession(msg.sessionId);
        } catch (err) {
          return send({ type: 'error', code: 'not_found', message: (err as Error).message });
        }
        // 快照 → 从 afterSeq 重放 → 挂上 live 监听。全程同步，中间不会漏掉新事件。
        send({ type: 'snapshot', session, pendingRequests: hub.pendingRequests(msg.sessionId), lastSeq: hub.lastSeq(msg.sessionId) });
        for (const event of hub.eventsAfter(msg.sessionId, msg.afterSeq)) send({ type: 'event', event });
        send({ type: 'replay.completed', lastSeq: hub.lastSeq(msg.sessionId) });
        subscriptions.set(msg.sessionId, hub.subscribe(msg.sessionId, (event: AgentEvent) => send({ type: 'event', event })));
        return;
      }
    }
  });

  socket.on('close', () => {
    for (const unsubscribe of subscriptions.values()) unsubscribe();
  });
});

app.addHook('onClose', () => {
  hub.close();
  store.close();
});

await app.listen({ port, host: '0.0.0.0' });
