// P0 验证：会话分叉（切片 17）。每轮结束记一个锚点，从锚点分叉出新的 Provider 会话，再在全新进程里 resume，看上下文是否正好截到该轮。
// 三种轮：纯文本、带工具、被中断。Claude 锚点 = 该轮最后一条主链消息（assistant / 顶层 user）的 uuid；Codex 锚点 = 该轮最后一个 turn id。
// 运行：cd apps/server && node scripts/p0-fork-harness.mjs claude|codex
// 会真实消耗额度（每个 Provider 约 6 轮对话）。
import { query, forkSession } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of Object.keys(process.env)) if (/^CLAUDE/.test(k)) delete process.env[k];
delete process.env.ANTHROPIC_API_KEY;

const CWD = realpathSync(mkdtempSync(join(tmpdir(), 'agentdeck-p0-fork-')));
const log = (tag, o) => console.log(`[${tag}]`, typeof o === 'string' ? o : JSON.stringify(o).slice(0, 600));
const prompts = [
  { text: 'Remember the codeword APPLE. Reply with OK only, no tools.' },
  { text: 'Run the shell command `echo hi` with your Bash/shell tool, then remember the codeword BANANA. Reply with OK only.' },
  { text: 'Run the shell command `python3 -c "import time; time.sleep(60)"` in the foreground with your Bash/shell tool (not in the background), then remember the codeword CHERRY.', interruptAfterMs: 8000 },
];
const recall = 'List every codeword I asked you to remember in this conversation, comma separated, nothing else. Do not use tools.';

async function claude() {
  const inbox = (() => {
    const q = []; let wake = null; let closed = false;
    return {
      push(m) { q.push(m); wake?.(); },
      close() { closed = true; wake?.(); },
      async *[Symbol.asyncIterator]() { while (true) { if (q.length) { yield q.shift(); continue; } if (closed) return; await new Promise((r) => (wake = r)); wake = null; } },
    };
  })();
  const user = (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null, uuid: crypto.randomUUID() });
  const env = { ...process.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' };
  const q = query({
    prompt: inbox,
    options: { cwd: CWD, env, permissionMode: 'default', settingSources: [], canUseTool: async (_t, input) => ({ behavior: 'allow', updatedInput: input }) },
  });
  let sessionId, last = null, idle;
  const anchors = [];
  const pump = (async () => {
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') sessionId = m.session_id;
      if ((m.type === 'assistant' || m.type === 'user') && m.parent_tool_use_id === null && m.uuid) {
        last = m.uuid;
        log('chain', { type: m.type, uuid: m.uuid, content: JSON.stringify(m.message.content).slice(0, 120) });
      }
      if (m.type === 'result') log('result', { subtype: m.subtype, uuid: m.uuid });
      if (m.type === 'system' && m.subtype === 'session_state_changed' && m.state === 'idle') idle?.();
    }
  })();
  for (const p of prompts) {
    const done = new Promise((r) => (idle = r));
    inbox.push(user(p.text));
    let finished = false;
    if (p.interruptAfterMs) setTimeout(() => { if (!finished) q.interrupt(); }, p.interruptAfterMs);
    await done;
    finished = true;
    anchors.push(last);
    log('anchor', last);
  }
  inbox.close();
  // 中断结果之后立刻关输入流，SDK 会抛 process exited（AGENTS.md 规则 3）；会话记录已落盘，不影响分叉
  await pump.catch((err) => log('pump', err.message));

  for (const [i, anchor] of anchors.entries()) {
    const { sessionId: forked } = await forkSession(sessionId, { dir: CWD, upToMessageId: anchor });
    let answer = '';
    for await (const m of query({ prompt: recall, options: { cwd: CWD, env, resume: forked, permissionMode: 'default', settingSources: [], canUseTool: async () => ({ behavior: 'deny', message: 'no' }) } })) {
      if (m.type === 'system' && m.subtype === 'init') log('resumed', { forked, sessionId: m.session_id });
      if (m.type === 'result') answer = m.subtype === 'success' ? m.result : `${m.subtype}: ${m.errors?.join(' ')}`;
    }
    log(`fork after turn ${i + 1}`, answer);
  }
}

function appServer() {
  const child = spawn('codex', ['app-server', '--enable', 'default_mode_request_user_input'], { stdio: ['pipe', 'pipe', 'inherit'] });
  let nextId = 1;
  const pending = new Map();
  const handlers = new Set();
  const write = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  createInterface({ input: child.stdout }).on('line', (line) => {
    const m = JSON.parse(line);
    if (m.id !== undefined && m.method === undefined) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    } else if (m.id !== undefined) {
      log('server request', m.method);
      write({ id: m.id, result: { decision: 'accept' } });
    } else for (const h of handlers) h(m);
  });
  const request = (method, params) => { const id = nextId++; write({ id, method, params }); return new Promise((resolve, reject) => pending.set(id, { resolve, reject })); };
  return {
    request,
    on: (h) => handlers.add(h),
    async init() {
      await request('initialize', { clientInfo: { name: 'agentdeck-harness', title: null, version: '0.0.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
      write({ method: 'initialized', params: {} });
    },
    kill: () => child.kill(),
  };
}

async function codex() {
  const policy = { cwd: CWD, approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'user' };
  const text = (s) => [{ type: 'text', text: s, text_elements: [] }];
  let server = appServer();
  await server.init();
  let turnDone;
  let answer = '';
  server.on((m) => {
    if (m.method === 'turn/completed') turnDone?.(m.params.turn);
    if (m.method === 'item/completed' && m.params.item.type === 'agentMessage') answer = m.params.item.text;
  });
  const { thread } = await server.request('thread/start', policy);
  const anchors = [];
  for (const p of prompts) {
    const done = new Promise((r) => (turnDone = r));
    const { turn } = await server.request('turn/start', { threadId: thread.id, input: text(p.text) });
    if (p.interruptAfterMs) setTimeout(() => server.request('turn/interrupt', { threadId: thread.id, turnId: turn.id }), p.interruptAfterMs);
    const t = await done;
    log('turn', { id: t.id, status: t.status });
    anchors.push(t.id);
  }
  const forks = [];
  for (const lastTurnId of anchors) {
    const res = await server.request('thread/fork', { threadId: thread.id, lastTurnId, ...policy, excludeTurns: true });
    log('fork', { id: res.thread.id, approvalPolicy: res.approvalPolicy, sandbox: res.sandbox.type });
    forks.push(res.thread.id);
  }
  // 全新 app-server：模拟 Hub 重启后按库里的 threadId resume 分叉出的 thread
  server.kill();
  server = appServer();
  await server.init();
  server.on((m) => {
    if (m.method === 'turn/completed') turnDone?.(m.params.turn);
    if (m.method === 'item/completed' && m.params.item.type === 'agentMessage') answer = m.params.item.text;
  });
  for (const [i, threadId] of forks.entries()) {
    const res = await server.request('thread/resume', { threadId, ...policy });
    log('resumed', { id: res.thread.id, approvalPolicy: res.approvalPolicy, sandbox: res.sandbox.type });
    const done = new Promise((r) => (turnDone = r));
    await server.request('turn/start', { threadId, input: text(recall) });
    await done;
    log(`fork after turn ${i + 1}`, answer);
  }
  server.kill();
}

const which = process.argv[2];
if (which === 'claude') await claude();
else if (which === 'codex') await codex();
else throw new Error('usage: node scripts/p0-fork-harness.mjs claude|codex');
