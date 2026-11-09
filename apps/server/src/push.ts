import type { ClientMessage, ServerMessage } from '@agentdeck/shared';
import type { Store } from './store/db';

// 推送到手机（Spug 推送，国行安卓收不到 Web Push）：没有页面在前台、电脑也不在用（锁屏、合盖、没开页面）时才推。
// 在线状态挂在 WS 连接上，合盖睡眠由 main.ts 的协议层心跳断开连接来发现。
// 地址取 Shared 密钥 SPUG_PUSH_URL，没配就不推；失败只记日志，不重试。
// 同一条内容也发给所有在线页面，由页面在不在前台决定弹不弹桌面系统通知。

type Presence = Omit<Extract<ClientMessage, { type: 'presence' }>, 'type'>;

export type Push = ReturnType<typeof createPush>;

export function createPush(store: Store) {
  const clients = new Map<{ send(data: string): void }, Presence>();
  let origin = store.getState<string>('publicOrigin');

  return {
    /** host 来自 Tailscale 访问时的 Host 头，用来拼通知里的会话链接；本机直连的不算 */
    presence(socket: { send(data: string): void }, presence: Presence, host: string | undefined) {
      clients.set(socket, presence);
      if (host && !/^(127\.0\.0\.1|localhost)(:|$)/.test(host) && origin !== `https://${host}`) {
        origin = `https://${host}`;
        store.setState('publicOrigin', origin);
      }
    },

    leave(socket: { send(data: string): void }) {
      clients.delete(socket);
    },

    send(title: string, content: string, sessionId: string) {
      // 桌面系统通知也走这里：页面自己知道是否在前台，由它决定弹不弹
      const notice: ServerMessage = { type: 'notice', sessionId, title, body: plainText(content) };
      for (const socket of clients.keys()) socket.send(JSON.stringify(notice));
      if ([...clients.values()].some((c) => c.foreground || (c.device === 'desktop' && !c.locked))) return;
      const secret = store.listSecrets().find((s) => s.workspaceId === null && s.name === 'SPUG_PUSH_URL');
      const url = secret && store.getSecretValue(secret.id);
      if (!url) return;
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'app', type: 'markdown', title: title.slice(0, 32), content: origin ? `${content}\n\n[Open session](${origin}/s/${sessionId})` : content }),
      })
        .then((res) => res.json() as Promise<{ code: number; msg: string }>)
        .then((res) => { if (res.code !== 200) console.warn(`Push failed: ${res.msg}`); })
        .catch((err: Error) => console.warn(`Push failed: ${err.message}`));
    },
  };
}

// 系统通知正文不渲染 Markdown，去掉常见标记；macOS 只显示两三行，截短即可
function plainText(markdown: string) {
  return markdown.replace(/\*\*|`/g, '').replace(/^(#+|-{3,})\s*/gm, '').replace(/\s+/g, ' ').trim().slice(0, 300);
}
