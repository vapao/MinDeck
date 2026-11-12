// P0 可行性验证：Provider 调用 Hub 的 HTTP MCP 工具（记录见 docs/remote_agent_hub_technical_plan.md §16.3）
// 验证：按会话注入的请求头能到达服务端；长时间阻塞的工具调用不被超时打断；approval 模式下 MCP 工具的审批走向。
// 运行：cd apps/server && node scripts/p0-mcp-harness.mjs [claude|codex]
// 会真实消耗额度（每个 Provider 2 轮对话）。
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { query } from '@anthropic-ai/claude-agent-sdk';

const CWD = mkdtempSync(join(tmpdir(), 'mindeck-p0-mcp-'));
const SLOW_SEC = 90;
const log = (tag, o) => console.log(`[${tag}]`, typeof o === 'string' ? o : JSON.stringify(o).slice(0, 600));

// 无状态 Streamable HTTP：每个请求一个 server + transport
const http = createServer(async (req, res) => {
  const caller = req.headers['x-mindeck-session'];
  const server = new McpServer({ name: 'mindeck', version: '0.0.0' });
  server.registerTool('whoami', { description: 'Return the caller id', inputSchema: {} }, async () => {
    log('mcp', `whoami caller=${caller}`);
    return { content: [{ type: 'text', text: `caller=${caller}` }] };
  });
  server.registerTool('slow', { description: 'Wait N seconds then return', inputSchema: { seconds: z.number() } }, async ({ seconds }) => {
    const t = Date.now();
    log('mcp', `slow ${seconds}s start caller=${caller}`);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    log('mcp', `slow done after ${Math.round((Date.now() - t) / 1000)}s, request closed=${req.destroyed}`);
    return { content: [{ type: 'text', text: `waited ${seconds}s` }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  let body = '';
  for await (const chunk of req) body += chunk;
  await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
});
await new Promise((r) => http.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${http.address().port}/mcp`;
log('p0', `mcp at ${URL_}, cwd ${CWD}`);

const PROMPT_1 = 'Call the mindeck whoami tool and reply with its exact output only.';
const PROMPT_2 = `Call the mindeck slow tool with seconds=${SLOW_SEC} and reply with its exact output only.`;

async function claude() {
  for (const [name, prompt, allowed] of [['whoami (not allowlisted)', PROMPT_1, []], ['slow (allowlisted)', PROMPT_2, ['mcp__mindeck__slow']]]) {
    log('claude', `--- ${name}`);
    const q = query({
      prompt,
      options: {
        cwd: CWD, permissionMode: 'default', settingSources: [], allowedTools: allowed, maxTurns: 4,
        mcpServers: { mindeck: { type: 'http', url: URL_, headers: { 'X-MinDeck-Session': 'claude-s1' }, timeout: 30 * 60_000, alwaysLoad: true } },
        canUseTool: async (toolName, input) => {
          log('claude.canUseTool', { toolName, input });
          return { behavior: 'allow', updatedInput: input };
        },
      },
    });
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') log('claude.init', m.mcp_servers);
      if (m.type === 'user') for (const b of m.message.content ?? []) if (b.type === 'tool_result') log('claude.tool_result', b.content);
      if (m.type === 'result') log('claude.result', { subtype: m.subtype, result: m.result, ms: m.duration_ms });
    }
  }
}

async function codex() {
  const child = spawn('codex', ['app-server', '--enable', 'default_mode_request_user_input'], { stdio: ['pipe', 'pipe', 'inherit'] });
  let nextId = 1;
  const pending = new Map();
  let onTurnDone;
  const write = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  createInterface({ input: child.stdout }).on('line', (line) => {
    const m = JSON.parse(line);
    if (m.id !== undefined && m.method === undefined) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    } else if (m.id !== undefined) {
      log('codex.serverRequest', m);
      // 模拟用户同意：elicitation 回 accept，其余审批回 accept
      write({ id: m.id, result: m.method === 'mcpServer/elicitation/request' ? { action: 'accept', content: {} } : { decision: 'accept' } });
    } else {
      if (m.method === 'item/started' || m.method === 'item/completed') {
        const it = m.params.item;
        if (it.type === 'mcpToolCall') log(`codex.${m.method}`, it);
        if (m.method === 'item/completed' && it.type === 'agentMessage') log('codex.answer', it.text);
      }
      if (m.method === 'turn/completed') onTurnDone?.(m.params.turn);
    }
  });
  const request = (method, params) => { const id = nextId++; write({ id, method, params }); return new Promise((resolve, reject) => pending.set(id, { resolve, reject })); };
  await request('initialize', { clientInfo: { name: 'mindeck-p0', title: 'p0', version: '0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
  write({ method: 'initialized', params: {} });
  // variant：on-request 下给 whoami 配 approval_mode = approve；bypass 下看是否还发 elicitation
  const bypass = process.argv[3] === 'bypass';
  const res = await request('thread/start', {
    cwd: CWD, approvalPolicy: bypass ? 'never' : 'on-request', sandbox: bypass ? 'danger-full-access' : 'workspace-write', approvalsReviewer: 'user', ephemeral: true,
    config: { 'mcp_servers.mindeck': { url: URL_, http_headers: { 'X-MinDeck-Session': 'codex-s1' }, tool_timeout_sec: 1800, tools: { whoami: { approval_mode: 'approve' } } } },
  });
  log('codex.thread', { approvalPolicy: res.approvalPolicy, sandbox: res.sandbox.type });
  for (const prompt of process.argv[3] ? [PROMPT_1, PROMPT_1.replace('whoami', 'slow tool with seconds=1, then the whoami')] : [PROMPT_1, PROMPT_2]) {
    log('codex', `--- ${prompt}`);
    const t = Date.now();
    const done = new Promise((r) => (onTurnDone = r));
    await request('turn/start', { threadId: res.thread.id, input: [{ type: 'text', text: prompt, text_elements: [] }] });
    const turn = await done;
    log('codex.turn', { status: turn.status, s: Math.round((Date.now() - t) / 1000) });
  }
  child.kill();
}

const which = process.argv[2] ?? 'claude';
await (which === 'codex' ? codex() : claude());
http.close();
