import { outputFile } from './output-files';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { ClientMessage, CreateSessionBody, CreateWorkspaceBody, ListDirsResponse, ResolvePendingBody, SendMessageBody, ServerMessage, UpdateSessionBody, UpdateSettingsBody, UpdateWorkspaceBody, UsageResponse, Workspace } from '@agentdeck/shared';
import { openStore } from './store/db';
import { createAttachmentStore, isImageMime, maxAttachmentBytes, maxAttachmentsPerMessage } from './store/attachments';
import { createHub, HubError } from './hub';
import { verifyDeepseekConnection } from './providers/claude';
import { fileDiff, listChanges, listEntries, readWorkspaceFile } from './changes';

const repoRoot = resolve(import.meta.dirname, '../../..');
// 端口分配见 ~/Workspace/mac-mini-tailscale-web-ports.md：8004 只监听本机；开发时由 vite dev server 代理，生产由 Tailscale Serve 8450 映射到这里
const port = Number(process.env.AGENTDECK_PORT ?? 8004);
const dbPath = process.env.AGENTDECK_DB ?? resolve(repoRoot, 'data/agentdeck.db');
const uploadsDir = process.env.AGENTDECK_UPLOADS ?? resolve(repoRoot, 'data/uploads');
// 工作区（方案 §11.3 allowlist）由 UI 从家目录内浏览添加，存 workspaces 表；目录浏览也限定在家目录内
const home = homedir();
// 生产模式由 Hub 直接托管前端构建产物（方案 §11.2：只监听本机，Tailscale Serve 映射到这个端口）；目录不存在则只提供 API，前端走 vite dev server
const webDist = process.env.AGENTDECK_WEB_DIST ?? resolve(repoRoot, 'apps/web/dist');

mkdirSync(dirname(dbPath), { recursive: true });
const store = openStore(dbPath);
const attachments = createAttachmentStore(store, uploadsDir);
const hub = createHub(store, attachments);
// 首次启动把本仓库种进去，否则新建会话页是空的
if (store.listWorkspaces().length === 0) store.createWorkspace({ id: randomUUID(), path: repoRoot, alias: basename(repoRoot), createdAt: new Date().toISOString() });

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

const insideHome = (p: string) => p === home || p.startsWith(`${home}/`);

app.get('/api/workspaces', () => store.listWorkspaces());

app.post<{ Body: CreateWorkspaceBody }>(
  '/api/workspaces',
  { schema: { body: { type: 'object', required: ['path', 'alias'], properties: { path: { type: 'string' }, alias: { type: 'string', minLength: 1 } } } } },
  (req, reply) => {
    const path = resolve(req.body.path);
    if (!insideHome(path)) throw new HubError(400, 'Only directories inside the home folder can be added');
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new HubError(400, 'Directory not found');
    if (store.getWorkspaceByPath(path)) throw new HubError(409, 'Directory already added');
    const w: Workspace = { id: randomUUID(), path, alias: req.body.alias.trim(), createdAt: new Date().toISOString() };
    store.createWorkspace(w);
    return reply.code(201).send(w);
  },
);

app.patch<{ Params: { id: string }; Body: UpdateWorkspaceBody }>(
  '/api/workspaces/:id',
  { schema: { body: { type: 'object', required: ['alias'], properties: { alias: { type: 'string', minLength: 1 } } } } },
  (req) => {
    if (!store.setWorkspaceAlias(req.params.id, req.body.alias.trim())) throw new HubError(404, 'Workspace not found');
    return store.getWorkspace(req.params.id);
  },
);

// 只从列表移除；该目录下已有的会话及其记录不动
app.delete<{ Params: { id: string } }>('/api/workspaces/:id', (req) => {
  if (!store.deleteWorkspace(req.params.id)) throw new HubError(404, 'Workspace not found');
  return { ok: true };
});

// 目录浏览（给添加工作区用）：只列家目录内的子目录，跳过隐藏目录；读不了的目录（权限）直接跳过
app.get<{ Querystring: { path?: string } }>('/api/fs/dirs', (req): ListDirsResponse => {
  const path = resolve(req.query.path ?? home);
  if (!insideHome(path)) throw new HubError(400, 'Only directories inside the home folder can be browsed');
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new HubError(404, 'Directory not found');
  const dirs = readdirSync(path, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => ({ name: d.name, path: resolve(path, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { path, parent: path === home ? null : dirname(path), dirs };
});

app.get('/api/settings', (_req, reply) => reply.header('cache-control', 'no-store').send(hub.settings()));

// 密钥只在用户点眼睛时单独读取，不进入普通设置响应或客户端查询缓存。
app.post('/api/settings/deepseek/reveal-key', (_req, reply) => reply.header('cache-control', 'no-store').send({ apiKey: store.getDeepseekApiKey() }));

app.post('/api/settings/deepseek/test', async () => {
  const { baseUrl, model } = hub.settings().deepseek;
  const apiKey = store.getDeepseekApiKey();
  if (!apiKey) throw new HubError(400, '请先保存 DeepSeek API Key');
  try {
    return await verifyDeepseekConnection(repoRoot, { baseUrl, apiKey }, model);
  } catch (error) {
    // 上游错误可能包含认证信息，不写入日志或回传密钥。
    throw new HubError(502, (error instanceof Error ? error.message : String(error)).replaceAll(apiKey, '[redacted]'));
  }
});

const providerDefaults = {
  type: 'object',
  required: ['model', 'effort', 'permissionMode'],
  properties: { model: { type: 'string' }, effort: { type: 'string' }, permissionMode: { type: 'string' } },
};
app.put<{ Body: UpdateSettingsBody }>(
  '/api/settings',
  { schema: { body: { type: 'object', required: ['claude', 'codex', 'deepseek'], properties: { titles: { type: 'object', required: ['enabled', 'provider', 'model'], properties: { enabled: { type: 'boolean' }, provider: { type: 'string' }, model: { type: 'string' } } }, claude: providerDefaults, codex: providerDefaults, deepseek: { ...providerDefaults, required: [...providerDefaults.required, 'baseUrl'], properties: { ...providerDefaults.properties, baseUrl: { type: 'string' }, apiKey: { type: 'string' } } } } } } },
  (req) => {
    hub.updateSettings(req.body);
    return hub.settings();
  },
);

app.get('/api/usage', (): UsageResponse => hub.usage);

app.get('/api/sessions', () => hub.listSessions());

app.post<{ Body: CreateSessionBody }>(
  '/api/sessions',
  {
    schema: {
      body: {
        type: 'object',
        required: ['provider', 'cwd'],
        properties: { provider: { type: 'string' }, cwd: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, permissionMode: { type: 'string' } },
      },
    },
  },
  (req, reply) =>
    reply.code(201).send(hub.createSession(req.body.provider, req.body.cwd, { model: req.body.model, effort: req.body.effort, permissionMode: req.body.permissionMode })),
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
    if (!text.trim() && attachmentIds.length === 0) throw new HubError(400, 'Message is empty');
    return reply.code(202).send(hub.sendMessage(req.params.id, text, attachmentIds));
  },
);

app.get<{ Params: { id: string } }>('/api/sessions/:id/changes', (req) => listChanges(hub.getSession(req.params.id).cwd));

const pathQuery = { schema: { querystring: { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1 } } } } };
app.get<{ Params: { id: string }; Querystring: { path: string } }>('/api/sessions/:id/diff', pathQuery, (req) => fileDiff(hub.getSession(req.params.id).cwd, req.query.path));
app.get<{ Params: { id: string }; Querystring: { path: string } }>('/api/sessions/:id/file', pathQuery, (req) => readWorkspaceFile(hub.getSession(req.params.id).cwd, req.query.path));

app.get<{ Params: { id: string }; Querystring: { path: string } }>('/api/sessions/:id/output', pathQuery, async (req, reply) => {
  reply.header('cache-control', 'no-store');
  return outputFile(hub.getSession(req.params.id).cwd, req.query.path);
});
app.get<{ Params: { id: string }; Querystring: { path: string; download?: string } }>('/api/sessions/:id/output/content', pathQuery, async (req, reply) => {
  const file = await outputFile(hub.getSession(req.params.id).cwd, req.query.path, false);
  if (file.kind === 'directory') throw new HubError(400, 'Directories cannot be downloaded');
  const inline = ['image', 'pdf', 'audio', 'video'].includes(file.kind) && req.query.download !== '1';
  reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "sandbox; default-src 'none'")
    .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, '%27')}`);
  return reply.type(inline ? file.mime : 'application/octet-stream').send(createReadStream(file.path));
});

app.get<{ Params: { id: string }; Querystring: { q?: string } }>('/api/sessions/:id/entries', (req) => listEntries(hub.getSession(req.params.id).cwd, req.query.q ?? ''));

app.patch<{ Params: { id: string }; Body: UpdateSessionBody }>(
  '/api/sessions/:id',
  { schema: { body: { type: 'object', properties: { archived: { type: 'boolean' }, provider: { enum: ['claude', 'codex', 'deepseek'] } }, oneOf: [{ required: ['archived'] }, { required: ['provider'] }] } } },
  (req) => ('provider' in req.body ? hub.setProvider(req.params.id, req.body.provider) : hub.setArchived(req.params.id, req.body.archived)),
);

app.delete<{ Params: { id: string } }>('/api/sessions/:id', (req) => {
  hub.deleteSession(req.params.id);
  return { ok: true };
});

app.post<{ Params: { id: string } }>('/api/sessions/:id/interrupt', async (req) => {
  await hub.interrupt(req.params.id);
  return { ok: true };
});

// multipart 单文件字段 file。只收图片（方案 §9.2）；HEIC 需客户端先转 JPEG（iOS 相册选图默认会转）
app.post<{ Params: { id: string } }>('/api/sessions/:id/attachments', async (req, reply) => {
  const session = hub.getSession(req.params.id);
  if (session.provider === 'deepseek' && session.model === 'deepseek-v4-pro') throw new HubError(400, 'DeepSeek Pro 不支持图片，请新建 Flash 会话');
  const file = await req.file();
  if (!file) throw new HubError(400, 'Missing file field "file"');
  if (!isImageMime(file.mimetype)) throw new HubError(415, `Unsupported type ${file.mimetype}; only PNG / JPEG / WebP / GIF are accepted`);
  const bytes = await file.toBuffer();
  return reply.code(201).send(attachments.save(session.id, file.filename, file.mimetype, bytes));
});

app.get<{ Params: { id: string } }>('/api/attachments/:id', (req, reply) => {
  const a = attachments.get(req.params.id);
  if (!a) throw new HubError(404, 'Attachment not found');
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

app.get('/ws', { websocket: true, preValidation: (req, reply, done) => (checkOrigin(req) ? done() : void reply.code(403).send({ message: 'Origin mismatch' })) }, (socket) => {
  const send = (m: ServerMessage) => socket.send(JSON.stringify(m));
  const subscriptions = new Map<string, () => void>();

  socket.on('message', (data: { toString(): string }) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return send({ type: 'error', code: 'bad_json', message: 'Message is not valid JSON' });
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
        subscriptions.set(
          msg.sessionId,
          hub.subscribe(msg.sessionId, send, () => {
            send({ type: 'session.deleted' });
            subscriptions.delete(msg.sessionId);
          }),
        );
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
