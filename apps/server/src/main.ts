import { outputFile } from './output-files';
import { createProjectEntry, deleteProjectEntry, editablePath, listProjectFiles, saveProjectFile } from './files';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { secretNamePattern } from '@agentdeck/shared';
import type { StewardMessageBody } from '@agentdeck/shared';
import type { ClientMessage, CreateServiceBody, CreateSessionBody, CreateTodoBody, UpdateTodoBody, CreateWorkspaceBody, ForkSessionBody, ForkSessionResponse, ListDirsResponse, ResolvePendingBody, SaveSecretBody, ScheduleConfig, UpdateSecretBody, SendMessageBody, ServerMessage, SkillsResponse, UpdateServiceBody, UpdateSessionBody, UpdateSettingsBody, UpdateWorkspaceBody, UsageResponse, Workspace } from '@agentdeck/shared';
import { openStore } from './store/db';
import { createAttachmentStore, isImageMime, maxAttachmentBytes, maxAttachmentsPerMessage } from './store/attachments';
import { createHub, HubError } from './hub';
import { listClaudeSkills, verifyDeepseekConnection } from './providers/claude';
import { listCodexSkills } from './providers/codex';
import { discardChange, fileDiff, listChanges, listEntries, readWorkspaceFile } from './changes';
import type { CreateProjectEntryBody, DeleteProjectEntryBody, DiscardChangeBody, SaveProjectFileBody } from '@agentdeck/shared';
import { createServices } from './services';
import { agentdeckMcpFor, registerMcpRoute } from './mcp';
import { readUpdateStatus } from './update-status';
import { createScheduler } from './schedules';
import { createSteward } from './steward';
import { createPush } from './push';

const repoRoot = resolve(import.meta.dirname, '../../..');
// 8004 只监听本机；开发时由 vite dev server 代理，生产由 Tailscale Serve 8450 映射到这里
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
const push = createPush(store);
const hub = createHub(store, attachments, (sessionId) => agentdeckMcpFor(`http://127.0.0.1:${port}/mcp`, sessionId), push);
const services = createServices(store, resolve(repoRoot, 'data/logs/services'));
const steward = createSteward(store, hub, services, resolve(dirname(dbPath), 'steward'));
const scheduler = createScheduler(store, hub, undefined, steward.tick);
// 首次启动把本仓库种进去，否则新建会话页是空的
if (store.listWorkspaces().length === 0) store.createWorkspace({ id: randomUUID(), path: repoRoot, alias: basename(repoRoot), createdAt: new Date().toISOString() });

const app = Fastify({ logger: true });
const instanceId = randomUUID();
await app.register(websocket);
await app.register(multipart, { limits: { files: 1, fileSize: maxAttachmentBytes } });

app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  if (!(err instanceof HubError)) app.log.error(err);
  return reply.code(err.statusCode ?? 500).send({ message: err.message });
});

await app.register(fastifyStatic, {
  root: webDist,
  serve: existsSync(webDist),
  // 预览文件自行设置 no-store；只有 vite 的哈希产物可永久缓存。
  setHeaders: (reply, path) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  },
});
if (existsSync(webDist)) {
  // SPA 路由（/new、/s/:id）直接打开或刷新时回 index.html
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/ws')) return reply.sendFile('index.html');
    return reply.code(404).send({ message: 'Not Found' });
  });
  app.log.info({ webDist }, 'serving web build');
}

const insideHome = (p: string) => p === home || p.startsWith(`${home}/`);

app.get('/api/update-status', (_req, reply) => reply.header('cache-control', 'no-store').send({
  instanceId, update: readUpdateStatus(resolve(dirname(dbPath), 'update-status.json')),
}));

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

// 只从列表移除；该目录下已有的会话及其记录不动，服务配置一起删（还有服务在跑时 409）
app.delete<{ Params: { id: string } }>('/api/workspaces/:id', (req) => {
  if (services.anyRunning(req.params.id)) throw new HubError(409, 'Stop the project services first');
  if (!store.deleteWorkspace(req.params.id)) throw new HubError(404, 'Workspace not found');
  return { ok: true };
});

// 密钥：值只在 GET /api/secrets/:id/value 下发，列表不带
const secretScope = (workspaceId: string | null) => {
  if (workspaceId !== null && !store.getWorkspace(workspaceId)) throw new HubError(400, 'Workspace not found');
  return workspaceId;
};
const secretFields = { workspaceId: { type: ['string', 'null'] }, username: { type: ['string', 'null'] }, description: { type: 'string' }, value: { type: 'string', minLength: 1 } };
const secretUsername = (username: string | null) => username?.trim() || null;
app.get('/api/secrets', (_req, reply) => reply.header('cache-control', 'no-store').send(store.listSecrets()));
app.get<{ Params: { id: string } }>('/api/secrets/:id/value', (req, reply) => {
  const value = store.getSecretValue(req.params.id);
  if (value === undefined) throw new HubError(404, 'Secret not found');
  return reply.header('cache-control', 'no-store').send({ value });
});
app.post<{ Body: SaveSecretBody }>(
  '/api/secrets',
  { schema: { body: { type: 'object', additionalProperties: false, required: ['workspaceId', 'name', 'username', 'description', 'value'], properties: { ...secretFields, name: { type: 'string', pattern: secretNamePattern } } } } },
  (req, reply) => reply.code(201).send(store.saveSecret(secretScope(req.body.workspaceId), req.body.name, secretUsername(req.body.username), req.body.description.trim(), req.body.value)),
);
app.patch<{ Params: { id: string }; Body: UpdateSecretBody }>(
  '/api/secrets/:id',
  { schema: { body: { type: 'object', additionalProperties: false, required: ['workspaceId', 'username', 'description'], properties: secretFields } } },
  (req) => {
    const secret = store.updateSecret(req.params.id, secretScope(req.body.workspaceId), secretUsername(req.body.username), req.body.description.trim(), req.body.value);
    if (secret === 'conflict') throw new HubError(409, 'A secret with this name already exists in that scope');
    if (!secret) throw new HubError(404, 'Secret not found');
    return secret;
  },
);
app.delete<{ Params: { id: string } }>('/api/secrets/:id', (req) => {
  if (!store.deleteSecret(req.params.id)) throw new HubError(404, 'Secret not found');
  return { ok: true };
});

// 项目服务（切片 14）：命令由用户配置、Hub 以登录 shell 执行，风险等同 bypass 会话（§11.3）
const serviceConfig = { name: { type: 'string', minLength: 1 }, command: { type: 'string', minLength: 1 }, subdir: { type: 'string' }, url: { type: 'string' } };
app.get('/api/services', () => services.list());
app.post<{ Body: CreateServiceBody }>(
  '/api/services',
  { schema: { body: { type: 'object', required: ['workspaceId', 'name', 'command', 'subdir', 'url'], properties: { workspaceId: { type: 'string' }, ...serviceConfig } } } },
  (req, reply) => reply.code(201).send(services.create(req.body)),
);
app.patch<{ Params: { id: string }; Body: UpdateServiceBody }>(
  '/api/services/:id',
  { schema: { body: { type: 'object', required: ['name', 'command', 'subdir', 'url'], properties: serviceConfig } } },
  (req) => services.update(req.params.id, req.body),
);
app.delete<{ Params: { id: string } }>('/api/services/:id', (req) => {
  services.remove(req.params.id);
  return { ok: true };
});
for (const action of ['start', 'stop', 'restart'] as const) {
  app.post<{ Params: { id: string } }>(`/api/services/:id/${action}`, async (req) => {
    await services[action](req.params.id);
    return { ok: true };
  });
}
app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>('/api/services/:id/log', (req, reply) => reply.header('cache-control', 'no-store').send(services.log(req.params.id, req.query.cursor)));

const scheduleBody = { schema: { body: { type: 'object', additionalProperties: false, required: ['name', 'provider', 'workspaceId', 'model', 'effort', 'permissionMode', 'prompt', 'kind', 'time', 'enabled'], properties: {
  name: { type: 'string' }, provider: { enum: ['claude', 'codex', 'deepseek'] }, workspaceId: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' },
  permissionMode: { type: 'string' }, prompt: { type: 'string' }, kind: { enum: ['once', 'daily', 'weekdays'] }, time: { type: 'string' }, enabled: { type: 'boolean' },
} } } };
app.get('/api/schedules', () => scheduler.list());
app.post<{ Body: ScheduleConfig }>('/api/schedules', scheduleBody, (req, reply) => reply.code(201).send(scheduler.create(req.body)));
app.patch<{ Params: { id: string }; Body: ScheduleConfig }>('/api/schedules/:id', scheduleBody, (req) => scheduler.update(req.params.id, req.body));
app.delete<{ Params: { id: string } }>('/api/schedules/:id', (req) => {
  scheduler.remove(req.params.id);
  return { ok: true };
});
app.post<{ Params: { id: string } }>('/api/schedules/:id/run', (req) => ({ sessionId: scheduler.runNow(req.params.id) }));

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
  { schema: { body: { type: 'object', required: ['claude', 'codex', 'deepseek'], properties: { titles: { type: 'object', required: ['enabled', 'provider', 'model'], properties: { enabled: { type: 'boolean' }, provider: { type: 'string' }, model: { type: 'string' } } }, steward: { type: 'object', required: ['provider', 'model', 'effort', 'briefTime'], properties: { provider: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, briefTime: { type: 'string' } } }, claude: providerDefaults, codex: providerDefaults, deepseek: { ...providerDefaults, required: [...providerDefaults.required, 'baseUrl'], properties: { ...providerDefaults.properties, baseUrl: { type: 'string' }, apiKey: { type: 'string' } } } } } } },
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

app.get<{ Params: { id: string } }>('/api/sessions/:id/changes', (req) => listChanges(hub.getSession(req.params.id).cwd, hub.repositoryBusyReason));
app.post<{ Params: { id: string }; Body: DiscardChangeBody }>('/api/sessions/:id/changes/discard', {
  schema: { body: { type: 'object', additionalProperties: false, required: ['path', 'base', 'discard'], properties: {
    path: { type: 'string', minLength: 1 }, base: { type: 'string', pattern: '^[a-f0-9]{40,64}$' }, discard: { enum: ['restore', 'delete'] },
  } } },
}, async (req) => {
  await discardChange(hub.getSession(req.params.id).cwd, req.body, hub.withIdleRepository);
  return { ok: true };
});

const pathQuery = { schema: { querystring: { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1 } } } } };
app.get<{ Params: { id: string }; Querystring: { path: string } }>('/api/sessions/:id/diff', pathQuery, (req) => fileDiff(hub.getSession(req.params.id).cwd, req.query.path));
app.get<{ Params: { id: string }; Querystring: { path: string } }>('/api/sessions/:id/file', pathQuery, (req) => readWorkspaceFile(hub.getSession(req.params.id).cwd, req.query.path));

app.get<{ Params: { id: string }; Querystring: { path: string } }>('/api/sessions/:id/output', pathQuery, async (req, reply) => {
  reply.header('cache-control', 'no-store');
  const cwd = hub.getSession(req.params.id).cwd;
  const file = await outputFile(cwd, req.query.path);
  // 截断的内容保存会丢掉后半段，只允许完整读取的文本进入编辑。
  return { ...file, editable: file.content !== null && !file.truncated && await editablePath(cwd, file.path) !== null };
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

// URL 保留绝对路径的目录层级，让 HTML、CSS 和 JS 中的相对资源引用由浏览器自然解析。
app.get<{ Params: { id: string; '*': string } }>('/api/sessions/:id/preview/*', async (req, reply) => {
  const file = await outputFile(hub.getSession(req.params.id).cwd, `/${req.params['*']}`, false);
  if (file.kind === 'directory') throw new HubError(400, 'Directories cannot be previewed');
  reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');
  return reply.sendFile(file.name, dirname(file.path), { cacheControl: false, etag: false, lastModified: false });
});

app.get<{ Params: { id: string }; Querystring: { q?: string } }>('/api/sessions/:id/entries', (req) => listEntries(hub.getSession(req.params.id).cwd, req.query.q ?? ''));

app.get<{ Params: { id: string } }>('/api/sessions/:id/skills', async (req): Promise<SkillsResponse> => {
  const { provider, cwd } = hub.getSession(req.params.id);
  // Codex 内置（system）和插件带的 skill 不进补全列表；只是不显示，Agent 照样能用，手打 $name 也照样生效
  const skills = provider === 'codex' ? (await listCodexSkills(cwd)).filter((s) => s.scope !== 'system' && !s.pluginId) : await listClaudeSkills(cwd);
  return { skills: skills.map(({ name, description }) => ({ name, description })) };
});

app.get<{ Params: { id: string }; Querystring: { path?: string; q?: string; hidden?: boolean } }>('/api/sessions/:id/files', {
  schema: { querystring: { type: 'object', properties: { path: { type: 'string' }, q: { type: 'string' }, hidden: { type: 'boolean' } } } },
}, async (req) => {
  const cwd = hub.getSession(req.params.id).cwd;
  return { ...await listProjectFiles(cwd, req.query.path ?? '', req.query.q ?? '', req.query.hidden ?? false), writeDisabled: hub.repositoryBusyReason(cwd) };
});

const projectEntryBody = { schema: { body: { type: 'object', additionalProperties: false, required: ['path', 'dir'], properties: {
  path: { type: 'string', minLength: 1 }, dir: { type: 'boolean' },
} } } };
app.post<{ Params: { id: string }; Body: CreateProjectEntryBody }>('/api/sessions/:id/files', projectEntryBody, async (req) => {
  const cwd = hub.getSession(req.params.id).cwd;
  await hub.withIdleRepository(cwd, () => createProjectEntry(cwd, req.body), 'Creating a file or folder');
  return { ok: true };
});
app.delete<{ Params: { id: string }; Body: DeleteProjectEntryBody }>('/api/sessions/:id/files', projectEntryBody, async (req) => {
  const cwd = hub.getSession(req.params.id).cwd;
  await hub.withIdleRepository(cwd, () => deleteProjectEntry(cwd, req.body), 'Deleting a file or folder');
  return { ok: true };
});

app.put<{ Params: { id: string }; Body: SaveProjectFileBody }>('/api/sessions/:id/files/content', {
  bodyLimit: 4 * 1024 * 1024,
  schema: { body: { type: 'object', additionalProperties: false, required: ['path', 'content'], properties: { path: { type: 'string', minLength: 1 }, content: { type: 'string' }, expected: { type: 'string' } } } },
}, async (req) => {
  const cwd = hub.getSession(req.params.id).cwd;
  await hub.withIdleRepository(cwd, () => saveProjectFile(cwd, req.body), 'Saving a file');
  return { ok: true };
});

app.patch<{ Params: { id: string }; Body: UpdateSessionBody }>(
  '/api/sessions/:id',
  { schema: { body: { type: 'object', properties: { archived: { type: 'boolean' }, provider: { enum: ['claude', 'codex', 'deepseek'] }, model: { type: 'string' }, effort: { type: 'string' }, spawnGranted: { type: 'boolean' } }, oneOf: [{ required: ['archived'] }, { required: ['provider'] }, { required: ['model', 'effort'] }, { required: ['spawnGranted'] }] } } },
  (req) =>
    'provider' in req.body ? hub.setProvider(req.params.id, req.body.provider)
    : 'model' in req.body ? hub.setModel(req.params.id, req.body.model, req.body.effort)
    : 'spawnGranted' in req.body ? hub.setSpawnGranted(req.params.id, req.body.spawnGranted)
    : hub.setArchived(req.params.id, req.body.archived),
);

app.post<{ Params: { id: string }; Body: ForkSessionBody }>(
  '/api/sessions/:id/fork',
  { schema: { body: { type: 'object', required: ['rewind'], properties: { beforeSeq: { type: 'integer' }, rewind: { type: 'boolean' } } } } },
  (req): Promise<ForkSessionResponse> => hub.forkSession(req.params.id, req.body.beforeSeq, req.body.rewind),
);

app.delete<{ Params: { id: string }; Querystring: { descendants?: boolean } }>(
  '/api/sessions/:id',
  { schema: { querystring: { type: 'object', properties: { descendants: { type: 'boolean' } } } } },
  (req) => {
    hub.deleteSession(req.params.id, req.query.descendants);
    return { ok: true };
  },
);

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

app.post<{ Params: { id: string } }>('/api/pending/:id/dismiss', (req) => {
  hub.dismissPending(req.params.id);
  return { ok: true };
});

app.get<{ Querystring: { done?: boolean } }>('/api/inbox', { schema: { querystring: { type: 'object', properties: { done: { type: 'boolean' } } } } }, (req, reply) =>
  reply.header('cache-control', 'no-store').send(hub.inbox(req.query.done ?? false)));
app.post<{ Params: { id: string } }>('/api/reports/:id/read', (req) => {
  hub.markReportRead(req.params.id);
  return { ok: true };
});

app.post<{ Params: { id: string } }>('/api/sessions/:id/review/dismiss', (req) => {
  hub.dismissReview(req.params.id);
  return { ok: true };
});
app.post<{ Params: { id: string } }>('/api/sessions/:id/todo-draft', (req) => hub.todoDraft(req.params.id));

app.get<{ Querystring: { done?: boolean } }>('/api/todos', { schema: { querystring: { type: 'object', properties: { done: { type: 'boolean' } } } } }, (req, reply) =>
  reply.header('cache-control', 'no-store').send(hub.listTodos(req.query.done ?? false)));
app.post<{ Body: CreateTodoBody }>('/api/todos', { schema: { body: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } } } }, (req) => hub.createTodo(req.body));
app.patch<{ Params: { id: string }; Body: UpdateTodoBody }>('/api/todos/:id', { schema: { body: { type: 'object' } } }, (req) => hub.updateTodo(req.params.id, req.body));
app.delete<{ Params: { id: string } }>('/api/todos/:id', (req) => {
  hub.deleteTodo(req.params.id);
  return { ok: true };
});

app.get('/api/wakeups', (_req, reply) => reply.header('cache-control', 'no-store').send(hub.listWakeups()));
app.delete<{ Params: { id: string } }>('/api/wakeups/:id', (req) => {
  hub.cancelWakeup(req.params.id);
  return { ok: true };
});

app.get('/api/steward', (_req, reply) => reply.header('cache-control', 'no-store').send(steward.view()));
app.post<{ Body: StewardMessageBody }>('/api/steward/messages', { schema: { body: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1 } } } } },
  (req, reply) => reply.code(202).send(steward.send(req.body.text)));
app.post('/api/steward/brief', async (_req, reply) => reply.code(202).send(await steward.brief()));
const memoryBody = { schema: { body: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1 } } } } };
app.post<{ Body: { text: string } }>('/api/steward/memories', memoryBody, (req, reply) => reply.code(201).send(steward.remember(req.body.text, true)));
app.patch<{ Params: { id: string }; Body: { text: string } }>('/api/steward/memories/:id', memoryBody, (req) => {
  steward.updateMemory(req.params.id, req.body.text);
  return { ok: true };
});
app.delete<{ Params: { id: string } }>('/api/steward/memories/:id', (req) => {
  steward.forget(req.params.id, true);
  return { ok: true };
});

registerMcpRoute(app, hub, store, services, scheduler, steward);

// 浏览器允许任意站点跨站发起 WebSocket（§11.3 Origin 检查）：Origin 存在时必须与访问的 Host 一致；非浏览器客户端没有 Origin，放行
const checkOrigin = (req: { headers: { origin?: string; host?: string } }) => !req.headers.origin || req.headers.origin.endsWith(`//${req.headers.host}`);

app.get('/ws', { websocket: true, preValidation: (req, reply, done) => (checkOrigin(req) ? done() : void reply.code(403).send({ message: 'Origin mismatch' })) }, (socket, req) => {
  const send = (m: ServerMessage) => socket.send(JSON.stringify(m));
  const subscriptions = new Map<string, () => void>();
  // 协议层 ping 由浏览器网络层回 pong，不受后台标签页的定时器节流；合盖睡眠后回不来，连续 3 次没回就断开，在线状态随之清掉
  let missed = 0;
  socket.on('pong', () => { missed = 0; });
  const heartbeat = setInterval(() => {
    if (missed++ >= 3) socket.terminate();
    else socket.ping();
  }, 15_000);

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
      case 'presence':
        return push.presence(socket, { device: msg.device, foreground: msg.foreground, locked: msg.locked }, req.headers.host);
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
    clearInterval(heartbeat);
    push.leave(socket);
    for (const unsubscribe of subscriptions.values()) unsubscribe();
  });
});

app.addHook('onClose', () => {
  stopScheduler();
  hub.close();
  store.close();
});

await app.listen({ port, host: '127.0.0.1' });
// 监听起来再开始执行：定时会话要连 /mcp
const stopScheduler = scheduler.start();
