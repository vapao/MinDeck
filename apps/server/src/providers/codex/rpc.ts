import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
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
  const child = spawn('codex', ['app-server', '--enable', 'default_mode_request_user_input'], { stdio: ['pipe', 'pipe', 'inherit'] });
  let nextId = 1;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  let exited = false;

  const write = (m: Record<string, unknown>) => {
    if (!exited) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  };

  createInterface({ input: child.stdout }).on('line', (line) => {
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
  });

  child.on('exit', (code, signal) => {
    exited = true;
    const reason = new Error(`codex app-server exited (${signal ?? `code ${code}`})`);
    for (const p of pending.values()) p.reject(reason);
    pending.clear();
    onExit(code === 0 || signal === 'SIGTERM' ? undefined : reason);
  });
  child.on('error', (err) => {
    exited = true;
    onExit(err);
  });

  return {
    request<M extends Method>(method: M, params: ParamsOf<M>): Promise<unknown> {
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
