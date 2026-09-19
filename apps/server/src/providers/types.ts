import type { ImageMimeType, PendingRequestBody, ProviderEvent, Resolution } from '@agentdeck/shared';

/** Hub 发给 Provider 的一条用户消息；图片已经落在本机磁盘，各 Provider 自己决定按路径还是按字节送 */
export type OutgoingMessage = {
  text: string;
  images: { mimeType: ImageMimeType; path: string }[];
};

/** 一个活的 Provider 会话：Hub 只通过这三个动作和它打交道（方案 §7.1 的最小子集） */
export type ProviderSession = {
  send(message: OutgoingMessage): void;
  /** 打断当前 turn；Provider 随后发 turn.completed(reason: 'interrupted') */
  interrupt(): Promise<void>;
  close(): void;
};

export type StartOptions = {
  cwd: string;
  /** Hub 重启后用保存的 providerSessionId 恢复上下文（方案 §6.2 / §5.2） */
  resume?: string;
  onEvent(event: ProviderEvent): void;
  /** 审批 / 提问：等用户在某个设备上处理；signal 触发（如 turn 被中断）时 resolve 为 null */
  onPending(body: PendingRequestBody, signal: AbortSignal): Promise<Resolution | null>;
  /** Provider 进程结束（正常关闭或抛错）后调用一次 */
  onExit(error?: unknown): void;
};
