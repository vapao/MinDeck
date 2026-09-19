// P0 可行性验证：Codex app-server stdio 链路（记录见 docs/remote_agent_hub_technical_plan.md §16.2）
// 用途：Codex 升级后的回归入口；也是 Codex normalizer 的真实样本来源。
// 运行：cd apps/server && node scripts/p0-codex-harness.mjs
// 会真实消耗 Codex 额度（约 7 轮对话）。
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { deflateSync } from 'node:zlib';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CWD = mkdtempSync(join(tmpdir(), 'agentdeck-p0-codex-'));
const log = (tag, o) => console.log(`[${tag}]`, typeof o === 'string' ? o : JSON.stringify(o).slice(0, 800));

// 生成一张 64x64 纯红色 PNG（无外部依赖）
function redPng() {
  const w = 64, h = 64;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const i = y * (w * 3 + 1) + 1 + x * 3; raw[i] = 255; raw[i+1] = 0; raw[i+2] = 0; } }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// 最小 JSON-RPC 客户端：一行一条消息；服务端发起的 request 交给 onServerRequest 决定回复
function startAppServer({ onServerRequest, onNotification }) {
  // 与 Provider 一致：让 request_user_input 在默认模式可用（不开这个 flag 它只在 Plan 模式存在）
  const child = spawn('codex', ['app-server', '--enable', 'default_mode_request_user_input'], { stdio: ['pipe', 'pipe', 'inherit'] });
  let nextId = 1;
  const pending = new Map();
  const write = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  createInterface({ input: child.stdout }).on('line', async (line) => {
    const m = JSON.parse(line);
    if (m.id !== undefined && m.method === undefined) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    } else if (m.id !== undefined) {
      write({ id: m.id, result: await onServerRequest(m) });
    } else {
      onNotification(m);
    }
  });
  return {
    request(method, params) {
      const id = nextId++;
      write({ id, method, params });
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    notify: (method, params) => write({ method, params }),
    kill: () => child.kill(),
    exited: new Promise((r) => child.on('exit', r)),
  };
}

const quiet = new Set(['item/agentMessage/delta', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta', 'item/reasoning/summaryPartAdded', 'mcpServer/startupStatus/updated', 'thread/tokenUsage/updated', 'remoteControl/status/changed', 'hook/started', 'hook/completed']);

async function run(step, threadId) {
  let turnDone;
  let currentTurnId = null;
  let approvalCount = 0;
  const seen = new Set();
  const server = startAppServer({
    onNotification(m) {
      seen.add(m.method);
      if (m.method === 'item/agentMessage/delta') process.stdout.write(m.params.delta);
      if (!quiet.has(m.method)) log('notif', { method: m.method, ...(m.method.startsWith('item/') ? { item: m.params.item?.type, status: m.params.item?.status } : {}) });
      if (m.method === 'turn/started') currentTurnId = m.params.turn.id;
      if (m.method === 'turn/completed') { log('turn', { status: m.params.turn.status, error: m.params.turn.error, durationMs: m.params.turn.durationMs }); turnDone?.(m.params.turn); }
      if (m.method === 'account/rateLimits/updated') log('rateLimits', m.params.rateLimits);
      if (m.method === 'error') log('error', m.params);
    },
    async onServerRequest(m) {
      log('SERVER REQUEST', { method: m.method, id: m.id, params: m.params });
      await new Promise((r) => setTimeout(r, 2000)); // 模拟异地设备处理延迟
      if (m.method === 'item/commandExecution/requestApproval') {
        // 第一次 accept，第二次 decline，看 decline 后 turn 是否继续
        const decision = approvalCount++ === 0 ? 'accept' : 'decline';
        log('reply', { decision });
        return { decision };
      }
      if (m.method === 'item/fileChange/requestApproval') return { decision: 'accept' };
      if (m.method === 'item/tool/requestUserInput') {
        const answers = Object.fromEntries(m.params.questions.map((q) => [q.id, { answers: [q.options?.[0]?.label ?? '随便'] }]));
        log('reply', answers);
        return { answers };
      }
      return {};
    },
  });

  await server.request('initialize', { clientInfo: { name: 'agentdeck-harness', title: null, version: '0.0.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
  server.notify('initialized', {});

  // 关键：本机 ~/.codex/config.toml 是 approval_policy=never + danger-full-access，必须在 thread 级显式覆盖
  const policy = { cwd: CWD, approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'user' };
  const t = threadId ? await server.request('thread/resume', { threadId, ...policy }) : await server.request('thread/start', policy);
  log('thread', { id: t.thread.id, model: t.model, approvalPolicy: t.approvalPolicy, sandbox: t.sandbox, turns: t.thread.turns?.length });
  threadId = t.thread.id;

  const turn = async (input, { interruptAfterMs } = {}) => {
    const done = new Promise((r) => (turnDone = r));
    const res = await server.request('turn/start', { threadId, input });
    currentTurnId = res.turn.id;
    if (interruptAfterMs) {
      setTimeout(async () => {
        log('interrupt', await server.request('turn/interrupt', { threadId, turnId: currentTurnId }));
      }, interruptAfterMs);
    }
    const result = await done;
    console.log();
    return result;
  };
  const text = (s) => ({ type: 'text', text: s, text_elements: [] });

  await step(turn, text, server);
  log('seen notifications', [...seen]);
  server.kill();
  await server.exited;
  return threadId;
}

const imgPath = join(CWD, 'red.png');
writeFileSync(imgPath, redPng());

const threadId = await run(async (turn, text) => {
  log('step', '1. localImage');
  await turn([text('这张图片是什么颜色？只回答颜色。'), { type: 'localImage', path: imgPath }]);

  log('step', '2. 沙箱外写文件 → 审批 accept');
  await turn([text('请执行 shell 命令 `echo probe > ~/agentdeck-p0-codex.txt`，不要解释。')]);

  log('step', '3. 再写一次 → 审批 decline，看 turn 是否正常结束');
  await turn([text('请执行 shell 命令 `echo again > ~/agentdeck-p0-codex-2.txt`，不要解释。如果被拒绝，回复"已拒绝"即可。')]);

  log('step', '4. requestUserInput');
  await turn([text('在动手之前，请用 request_user_input 工具问我一个问题：想用哪种语言写 hello world？给出 Python / Go 两个选项。拿到答案后只回复我选的语言，不要写代码。')]);

  log('step', '5. interrupt');
  await turn([text('从 1 数到 300，每个数字一行，中间不要停。')], { interruptAfterMs: 4000 });

  log('step', '6. 打断后继续');
  await turn([text('刚才数到哪了？一句话回答。')]);
});

log('step', '7. 新进程 thread/resume');
await run(async (turn, text) => {
  await turn([text('回忆一下：本次对话开头那张图片是什么颜色？我在第 4 步选了哪种语言？')]);
}, threadId);

log('done', { threadId, CWD });
