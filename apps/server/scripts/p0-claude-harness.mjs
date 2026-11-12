// P0 可行性验证：Claude Agent SDK Streaming Input 链路（2026-09-19 通过，记录见 docs/remote_agent_hub_technical_plan.md §16.1）
// 用途：SDK 升级后的回归入口；也是统一事件 normalizer 的真实样本来源。
// 运行：cd apps/server && node scripts/p0-claude-harness.mjs
// 会真实消耗 Claude 额度（约 4 轮对话）。
import { query } from '@anthropic-ai/claude-agent-sdk';
import { deflateSync } from 'node:zlib';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 避免被识别为嵌套 Claude Code 会话
for (const k of Object.keys(process.env)) if (/^CLAUDE/.test(k)) delete process.env[k];
delete process.env.ANTHROPIC_API_KEY; // 关键验证：不给 API Key，看 SDK 用什么凭据

const CWD = mkdtempSync(join(tmpdir(), 'mindeck-p0-'));
const log = (tag, o) => console.log(`[${tag}]`, typeof o === 'string' ? o : JSON.stringify(o));

// 生成一张 64x64 纯红色 PNG（无外部依赖）
function redPng() {
  const w = 64, h = 64;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const i = y * (w * 3 + 1) + 1 + x * 3; raw[i] = 255; raw[i+1] = 0; raw[i+2] = 0; } }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

// 一个可以从外部 push 消息的 AsyncIterable，模拟 Hub 收到客户端消息后转发
function inbox() {
  const q = []; let wake = null; let closed = false;
  return {
    push(m) { q.push(m); wake?.(); },
    close() { closed = true; wake?.(); },
    async *[Symbol.asyncIterator]() { while (true) { if (q.length) { yield q.shift(); continue; } if (closed) return; await new Promise(r => (wake = r)); wake = null; } },
  };
}
const user = (content) => ({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });

const results = {};
let sessionId;
let sawDelta = 0;

// ---------- Phase 1: 长驻 streaming session ----------
{
  const inb = inbox();
  let turn = 0;
  const q = query({
    prompt: inb,
    options: {
      cwd: CWD,
      permissionMode: 'default',
      includePartialMessages: true,
      settingSources: ['user', 'project'],
      canUseTool: async (toolName, input, { suggestions }) => {
        log('canUseTool', { toolName, input, suggestionsCount: suggestions?.length ?? 0 });
        // 模拟 Hub 落库 PendingRequest -> 推到 iPhone -> 2 秒后用户批准
        await new Promise(r => setTimeout(r, 2000));
        log('canUseTool', 'resolved: allow (模拟远端设备批准)');
        results.approval = true;
        return { behavior: 'allow', updatedInput: input };
      },
    },
  });

  // turn 1: 文本 + 图片
  inb.push(user([
    { type: 'text', text: '这张图是什么颜色？只回答颜色名，不要用任何工具。' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: redPng() } },
  ]));

  try { for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') {
      sessionId = m.session_id;
      log('init', { session_id: m.session_id, apiKeySource: m.apiKeySource, model: m.model, permissionMode: m.permissionMode, claude_code_version: m.claude_code_version, tools: m.tools.length, skills: m.skills.length, plugins: m.plugins.length, mcp_servers: m.mcp_servers.map(s => s.name) });
      results.auth = m.apiKeySource;
      results.localConfig = { skills: m.skills.slice(0, 5), plugins: m.plugins.map(p => p.name).slice(0, 5) };
    } else if (m.type === 'stream_event') {
      if (m.event?.type === 'content_block_delta' && m.event.delta?.type === 'text_delta') { sawDelta++; process.stdout.write(m.event.delta.text); }
    } else if (m.type === 'assistant') {
      const text = m.message.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const tools = m.message.content.filter(b => b.type === 'tool_use').map(b => b.name);
      console.log(); log('assistant', { text: text.slice(0, 120), tools });
    } else if (m.type === 'result') {
      turn++;
      log('result', { turn, subtype: m.subtype, session_id: m.session_id, num_turns: m.num_turns, cost_usd: m.total_cost_usd, error: m.subtype !== 'success' ? (m.errors ?? m.result) : undefined });
      if (turn === 1) {
        results.image = m.subtype === 'success';
        results.streamDeltas = sawDelta;
        // turn 2: 触发 Bash 权限 -> canUseTool
        inb.push(user('请用 Bash 工具执行 `date > hub-probe.txt && cat hub-probe.txt`，并把输出原样告诉我。'));
      } else if (turn === 2) {
        results.bashTurn = m.subtype === 'success';
        // turn 3: 长任务 + interrupt
        inb.push(user('请从 1 数到 200，每行一个数字，不要用工具。'));
        setTimeout(async () => { log('interrupt', 'calling q.interrupt()'); await q.interrupt(); log('interrupt', 'returned'); }, 1500);
      } else if (turn === 3) {
        results.interrupt = m.subtype;
        // turn 4: interrupt 之后同一 session 还能继续
        inb.push(user('刚才被打断了。现在只回答一个词：继续'));
      } else if (turn === 4) {
        results.afterInterrupt = m.subtype === 'success';
        inb.close();
      }
    } else if (m.type !== 'user') {
      // 其它系统消息只记类型，便于设计 normalizer
      log('other', m.type + (m.subtype ? '/' + m.subtype : ''));
    }
  } } catch (e) { log('phase1-error', String(e.message).slice(0, 200)); results.phase1Error = String(e.message).slice(0, 200); }
}

// ---------- Phase 2: 新进程 resume 同一 session ----------
{
  log('resume', `resuming ${sessionId}`);
  const q = query({ prompt: '我上一轮让你 echo 的内容是什么？只回答那个词。', options: { cwd: CWD, resume: sessionId, permissionMode: 'default', settingSources: ['user', 'project'] } });
  for await (const m of q) {
    if (m.type === 'assistant') { const t = m.message.content.filter(b => b.type === 'text').map(b => b.text).join(''); log('assistant', t.slice(0, 120)); results.resumeAnswer = t; }
    if (m.type === 'result') { log('result', { subtype: m.subtype, session_id: m.session_id, sameSession: m.session_id === sessionId }); results.resume = m.subtype === 'success' && m.session_id === sessionId; }
  }
}

console.log('\n===== SUMMARY =====');
console.log(JSON.stringify(results, null, 2));
