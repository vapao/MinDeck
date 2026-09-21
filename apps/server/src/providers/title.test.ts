import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateTitle } from './title';

// 标题请求只能看到传入文字，不能获得工具；DeepSeek 认证必须仍限定在该请求内。
test('title SDK requests contain no tools and keep DeepSeek credentials isolated', async () => {
  const requests: { model: string; tools?: unknown[]; messages: unknown }[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    if (req.url?.includes('count_tokens')) { res.setHeader('content-type', 'application/json'); res.end('{"input_tokens":10}'); return; }
    if (!req.url?.includes('/messages')) { res.writeHead(404).end(); return; }
    assert.equal(req.headers.authorization, 'Bearer title-test-key');
    const request = JSON.parse(body);
    requests.push(request);
    const title = '自动生成简短会话标题并保存配置';
    const message = { id: 'msg_test', type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const data of [
      { type: 'message_start', message },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: title } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 15 } },
      { type: 'message_stop' },
    ]) res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const before = { ...process.env };
  try {
    const title = await generateTitle({ enabled: true, provider: 'deepseek', model: 'deepseek-flash' }, '请增加自动会话标题', new AbortController(), { baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'title-test-key' });
    assert.equal(Array.from(title).length, 15);
    assert.ok(requests.length > 0);
    for (const request of requests) {
      assert.equal(request.model, 'deepseek-flash');
      assert.deepEqual(request.tools ?? [], []);
      assert.ok(JSON.stringify(request.messages).includes('请增加自动会话标题'));
      assert.ok(!JSON.stringify(request.messages).includes('AGENTS.md'));
    }
    for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(process.env[key], before[key]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
