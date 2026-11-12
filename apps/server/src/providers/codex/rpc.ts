import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import type { ClientRequest, ServerNotification, ServerRequest } from './schema';

// codex app-server 的 stdio JSONL 传输（方案 §2.1）：一行一条 JSON-RPC 2.0 消息，双向都能发 request。

type Method = ClientRequest['method'];
type ParamsOf<M extends Method> = Extract<ClientRequest, { method: M }>['params'];

export type RpcHandlers = {
  onNotification(n: ServerNotification): void;
  /** 服务端发起的 request：返回值作为 result 回复；抛出的 Error 作为 JSON-RPC error 回复 */
  onRequest(r: ServerRequest): Promise<unknown>;
  onExit(error?: unknown): void;
};

export class RpcError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

export function spawnAppServer({ onNotification, onRequest, onExit }: RpcHandlers) {
  // request_user_input 默认只在 Plan 模式可用；这个 feature flag 让它在默认模式也能用（P0 验证，见 §16.2）
  const child = spawn(process.execPath, [createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js'), 'app-server', '--enable', 'default_mode_request_user_input'], { stdio: ['pipe', 'pipe', 'inherit'] });
  let nextId = 1;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  let exited = false;

  const write = (m: Record<string, unknown>) => {
    if (!exited) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  };

  const onLine = (line: string) => {
    const m = JSON.parse(line);
    if (m.id !== undefined && m.method === undefined) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p?.reject(new RpcError(m.error.code, m.error.message));
      else p?.resolve(m.result);
    } else if (m.id !== undefined) {
      onRequest(m).then(
        (result) => write({ id: m.id, result }),
        (err: Error) => write({ id: m.id, error: { code: err instanceof RpcError ? err.code : -32603, message: err.message } }),
      );
    } else {
      onNotification(m);
    }
  };

  // 不用 readline：它把 U+2028/U+2029 也当换行，而 JSON 不转义这两个字符，网页快照里出现就会切断 JSON 让 Hub 崩溃
  let buf = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    buf += chunk;
    for (let i; (i = buf.indexOf('\n')) >= 0; ) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      onLine(line);
    }
  });

  // spawn 失败只触发 error 不触发 exit，等待中的请求也要在这里结束，否则界面一直转圈
  let failure: Error | undefined;
  const fail = (reason: Error) => {
    exited = true;
    failure = reason;
    for (const p of pending.values()) p.reject(reason);
    pending.clear();
  };
  child.on('exit', (code, signal) => {
    const reason = new Error(`codex app-server exited (${signal ?? `code ${code}`})`);
    fail(reason);
    onExit(code === 0 || signal === 'SIGTERM' ? undefined : reason);
  });
  child.on('error', (err) => {
    fail(err);
    onExit(err);
  });

  return {
    request<M extends Method>(method: M, params: ParamsOf<M>): Promise<unknown> {
      if (failure) return Promise.reject(failure);
      const id = nextId++;
      write({ id, method, params });
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    notify(method: string, params: unknown) {
      write({ method, params });
    },
    kill() {
      child.kill();
    },
  };
}

export type AppServerRpc = ReturnType<typeof spawnAppServer>;
