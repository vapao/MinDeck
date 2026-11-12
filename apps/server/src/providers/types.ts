import type { ImageMimeType, PendingRequestBody, PermissionMode, ProviderOutput, Resolution } from '@mindeck/shared';

/** Hub 发给 Provider 的一条用户消息；图片已经落在本机磁盘，各 Provider 自己决定按路径还是按字节送 */
export type OutgoingMessage = {
  text: string;
  images: { mimeType: ImageMimeType; path: string }[];
};

/** 一个活的 Provider 会话：Hub 只通过这三个动作和它打交道（方案 §7.1 的最小子集） */
export type ProviderSession = {
  /**
   * 空闲时开一轮；一轮进行中则插入当前轮，Agent 在下一步（工具调用返回后）就能看到。
   * 不管插入了几条、Provider 内部实际跑了几轮，都只在全部处理完、回到空闲时发一次 turn.completed / turn.failed
   */
  send(message: OutgoingMessage): void;
  /** 打断当前 turn，还没被 Agent 读到的插入消息一并丢弃；Provider 随后发 turn.completed(reason: 'interrupted') */
  interrupt(): Promise<void>;
  close(): void;
};

export type StartOptions = {
  cwd: string;
  deepseek?: { baseUrl: string; apiKey: string };
  /** Hub 重启后用保存的 providerSessionId 恢复上下文（方案 §6.2 / §5.2） */
  resume?: string;
  /** 会话创建时定下的模型 / 思考等级；省略交给 Provider 默认。取值范围见 shared modelOptions / effortOptions */
  model?: string;
  effort?: string;
  /** 'approval'（默认）走 Hub 审批卡；'bypass' 让 Provider 不经审批直接执行，风险自负 */
  permissionMode: PermissionMode;
  /** Hub 自己的会话编排 MCP 端点，headers 里带调用方会话；autoApprove 里的工具 Provider 侧不再审批 */
  mindeckMcp: MindeckMcp;
  onEvent(event: ProviderOutput): void;
  /** 审批 / 提问：等用户在某个设备上处理；signal 触发（如 turn 被中断）时 resolve 为 null */
  onPending(body: PendingRequestBody, signal: AbortSignal): Promise<Resolution | null>;
  /** Provider 进程结束（正常关闭或抛错）后调用一次 */
  onExit(error?: unknown): void;
};

export type MindeckMcp = { url: string; headers: Record<string, string>; timeoutSec: number; autoApprove: readonly string[] };
