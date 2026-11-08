import type { Store } from './store/db';

// 推送到手机（Spug 推送，国行安卓收不到 Web Push）：所有设备都不在前台时才推。
// 地址取 Shared 密钥 SPUG_PUSH_URL，没配就不推；失败只记日志，不重试。

/** 页面在前台时每 10 秒上报一次，离开前台时立刻上报；超过这个时长没报算离开（页面被杀、断网） */
const presenceTtl = 25_000;

export type Push = ReturnType<typeof createPush>;

export function createPush(store: Store) {
  const foreground = new Map<string, number>();
  let origin = store.getState<string>('publicOrigin');

  return {
    /** host 来自 Tailscale 访问时的 Host 头，用来拼通知里的会话链接；本机直连的不算 */
    presence(clientId: string, visible: boolean, host: string | undefined) {
      if (visible) foreground.set(clientId, Date.now() + presenceTtl);
      else foreground.delete(clientId);
      if (host && !/^(127\.0\.0\.1|localhost)(:|$)/.test(host) && origin !== `https://${host}`) {
        origin = `https://${host}`;
        store.setState('publicOrigin', origin);
      }
    },

    sessionLink(sessionId: string) {
      return origin ? `\n\n[Open session](${origin}/s/${sessionId})` : '';
    },

    send(title: string, content: string) {
      const now = Date.now();
      if ([...foreground.values()].some((until) => until > now)) return;
      const secret = store.listSecrets().find((s) => s.workspaceId === null && s.name === 'SPUG_PUSH_URL');
      const url = secret && store.getSecretValue(secret.id);
      if (!url) return;
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'app', type: 'markdown', title: title.slice(0, 32), content }),
      })
        .then((res) => res.json() as Promise<{ code: number; msg: string }>)
        .then((res) => { if (res.code !== 200) console.warn(`Push failed: ${res.msg}`); })
        .catch((err: Error) => console.warn(`Push failed: ${err.message}`));
    },
  };
}
