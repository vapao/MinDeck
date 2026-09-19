import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { AgentEvent, ClientMessage, CreateSessionBody, ResolvePendingBody, SendMessageBody, ServerMessage } from '@agentdeck/shared';
import { openStore } from './store/db';
import { createAttachmentStore, isImageMime, maxAttachmentBytes, maxAttachmentsPerMessage } from './store/attachments';
import { createHub, HubError } from './hub';

const repoRoot = resolve(import.meta.dirname, '../../..');
// 端口分配见 ~/Workspace/mac-mini-tailscale-web-ports.md：8004 只监听本机；开发时由 vite dev server 代理，生产由 Tailscale Serve 8450 映射到这里
const port = Number(process.env.AGENTDECK_PORT ?? 8004);
const dbPath = process.env.AGENTDECK_DB ?? resolve(repoRoot, 'data/agentdeck.db');
const uploadsDir = process.env.AGENTDECK_UPLOADS ?? resolve(repoRoot, 'data/uploads');
// 工作区 allowlist（方案 §11.3）：逗号分隔的绝对路径；默认只允许本仓库
const workspaces = (process.env.AGENTDECK_WORKSPACES ?? repoRoot).split(',').map((p) => resolve(p));
// 生产模式由 Hub 直接托管前端构建产物（方案 §11.2：只监听本机，Tailscale Serve 映射到这个端口）；目录不存在则只提供 API，前端走 vite dev server
const webDist = process.env.AGENTDECK_WEB_DIST ?? resolve(repoRoot, 'apps/web/dist');

mkdirSync(dirname(dbPath), { recursive: true });
const store = openStore(dbPath);
const attachments = createAttachmentStore(store, uploadsDir);
const hub = createHub(store, attachments, workspaces);

const app = Fastify({ logger: true });
await app.register(websocket);
await app.register(multipart, { limits: { files: 1, fileSize: maxAttachmentBytes } });

app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  if (!(err instanceof HubError)) app.log.error(err);
  return reply.code(err.statusCode ?? 500).send({ message: err.message });
});

if (existsSync(webDist)) {
  await app.register(fastifyStatic, {
    root: webDist,
    // vite 产物按内容哈希命名可永久缓存；index.html / sw.js / manifest 必须每次回源，否则 PWA 更新不到
    setHeaders: (reply, path) => reply.header('cache-control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'),
  });
  // SPA 路由（/new、/s/:id）直接打开或刷新时回 index.html
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/ws')) return reply.sendFile('index.html');
    return reply.code(404).send({ message: 'Not Found' });
  });
  app.log.info({ webDist }, 'serving web build');
}

app.get('/api/workspaces', () => workspaces.map((cwd) => ({ cwd })));

app.get('/api/sessions', () => hub.listSessions());

app.post<{ Body: CreateSessionBody }>(
  '/api/sessions',
  { schema: { body: { type: 'object', required: ['provider', 'cwd'], properties: { provider: { type: 'string' }, cwd: { type: 'string' } } } } },
  (req, reply) => reply.code(201).send(hub.createSession(req.body.provider, req.body.cwd)),
);

app.post<{ Params: { id: string }; Body: SendMessageBody }>(
  '/api/sessions/:id/messages',
  {
    schema: {
      body: {
        type: 'object',
        required: ['text'],
        properties: { text: { type: 'string' }, attachmentIds: { type: 'array', items: { type: 'string' }, maxItems: maxAttachmentsPerMessage } },
      },
    },
  },
  (req, reply) => {
    const { text, attachmentIds = [] } = req.body;
    if (!text.trim() && attachmentIds.length === 0) throw new HubError(400, '消息不能为空');
    return reply.code(202).send(hub.sendMessage(req.params.id, text, attachmentIds));
  },
);

app.post<{ Params: { id: string } }>('/api/sessions/:id/interrupt', async (req) => {
  await hub.interrupt(req.params.id);
  return { ok: true };
});

// multipart 单文件字段 file。只收图片（方案 §9.2）；HEIC 需客户端先转 JPEG（iOS 相册选图默认会转）
app.post<{ Params: { id: string } }>('/api/sessions/:id/attachments', async (req, reply) => {
  const session = hub.getSession(req.params.id);
  const file = await req.file();
  if (!file) throw new HubError(400, '缺少文件字段 file');
  if (!isImageMime(file.mimetype)) throw new HubError(415, `不支持的类型 ${file.mimetype}，只接受 PNG / JPEG / WebP / GIF`);
  const bytes = await file.toBuffer();
  return reply.code(201).send(attachments.save(session.id, file.filename, file.mimetype, bytes));
});

app.get<{ Params: { id: string } }>('/api/attachments/:id', (req, reply) => {
  const a = attachments.get(req.params.id);
  if (!a) throw new HubError(404, '附件不存在');
  // id 是随机 UUID 且内容不可变，可长期缓存
  return reply.type(a.mimeType).header('cache-control', 'private, max-age=31536000, immutable').send(createReadStream(attachments.pathOf(a)));
});

app.post<{ Params: { id: string }; Body: ResolvePendingBody }>(
  '/api/pending/:id/resolve',
  { schema: { body: { type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: ['approval', 'question'] } } } } },
  (req) => ({ seq: hub.resolvePending(req.params.id, req.body) }),
);

// 浏览器允许任意站点跨站发起 WebSocket（§11.3 Origin 检查）：Origin 存在时必须与访问的 Host 一致；非浏览器客户端没有 Origin，放行
const checkOrigin = (req: { headers: { origin?: string; host?: string } }) => !req.headers.origin || req.headers.origin.endsWith(`//${req.headers.host}`);

app.get('/ws', { websocket: true, preValidation: (req, reply, done) => (checkOrigin(req) ? done() : void reply.code(403).send({ message: 'Origin 不匹配' })) }, (socket) => {
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
        send({ type: 'snapshot', session, pendingRequests: hub.pendingRequests(msg.sessionId), lastSeq: hub.lastSeq(msg.sessionId), usage: hub.usage });
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

await app.listen({ port, host: '127.0.0.1' });
