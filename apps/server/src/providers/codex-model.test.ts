import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderOutput } from '@mindeck/shared';
import { shutdownCodex, startCodexSession } from './codex';

test('Codex honors the selected model on start and resume, and refuses a different model', { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mindeck-model-'));
  const previousPath = process.env.PATH;
  writeFileSync(join(dir, 'codex'), String.raw`#!/usr/bin/env node
const { createInterface } = require('node:readline');
const { appendFileSync } = require('node:fs');
const { join } = require('node:path');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
let count = 0;
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  appendFileSync(join(__dirname, 'requests.jsonl'), line + '\n');
  if (m.method === 'initialize') send({ id: m.id, result: {} });
  if (m.method === 'thread/start' || m.method === 'thread/resume') send({ id: m.id, result: {
    thread: { id: m.params.threadId ?? 'thread-' + ++count },
    model: m.params.threadId === 'reject-model' ? 'gpt-6-sol' : m.params.model ?? 'gpt-6-sol',
    approvalPolicy: m.params.approvalPolicy, sandbox: { type: 'workspaceWrite' }
  } });
  if (m.method === 'turn/start') {
    const turn = { id: 'turn-' + ++count, status: 'completed', error: null, durationMs: 0 };
    send({ id: m.id, result: { turn } });
    send({ method: 'turn/completed', params: { threadId: m.params.threadId, turn } });
  }
});
`, { mode: 0o755 });
  process.env.PATH = `${dir}:${previousPath}`;
  try {
    for (const options of [
      { model: 'gpt-6-astra' },
      { model: 'gpt-6-astra', resume: 'existing-thread' },
      {},
      { model: 'gpt-6-astra', resume: 'reject-model' },
    ]) {
      const events: ProviderOutput[] = [];
      let resolveDone!: () => void;
      let rejectDone!: (error: unknown) => void;
      const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
      const session = startCodexSession({
        cwd: dir, permissionMode: 'approval', ...options,
        mindeckMcp: { url: 'http://127.0.0.1:0/mcp', headers: {}, timeoutSec: 1, autoApprove: [] },
        onEvent(event) {
          events.push(event);
          if (event.type === 'turn.completed') resolveDone();
          if (event.type === 'turn.failed') rejectDone(new Error(event.payload.message));
        },
        onPending: async () => null,
        onExit: (error) => rejectDone(error ?? new Error('Unexpected app-server exit')),
      });
      try {
        session.send({ text: 'hello', images: [] });
        if (options.resume === 'reject-model') {
          await assert.rejects(done, /Codex did not accept.*model/);
          assert.deepEqual(events, []);
        } else {
          await done;
          const opened = events.find((event) => event.type === 'session.started' || event.type === 'session.resumed');
          assert.equal(opened?.type, options.resume ? 'session.resumed' : 'session.started');
          assert.equal(opened?.payload.model, options.model ?? 'gpt-6-sol');
        }
      } finally {
        session.close();
      }
    }
    const requests = readFileSync(join(dir, 'requests.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(requests.filter((r) => r.method === 'turn/start').map((r) => r.params.model), ['gpt-6-astra', 'gpt-6-astra', undefined]);
    assert.equal(requests.at(-1).method, 'thread/resume');
  } finally {
    shutdownCodex();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
