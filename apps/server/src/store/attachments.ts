import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Attachment, ImageMimeType } from '@mindeck/shared';
import type { Store } from './db';

// 图片字节落在服务端私有目录 <root>/<sessionId>/<id>.<ext>（方案 §9.2）。
// 路径完全由服务端生成：客户端提供的文件名只作展示，不参与路径。

const extByMime: Record<ImageMimeType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

export const maxAttachmentBytes = 10 * 1024 * 1024;
export const maxAttachmentsPerMessage = 5;

export function isImageMime(mime: string): mime is ImageMimeType {
  return mime in extByMime;
}

export function createAttachmentStore(store: Store, root: string) {
  const pathOf = (a: Attachment) => join(root, a.sessionId, `${a.id}.${extByMime[a.mimeType]}`);

  return {
    save(sessionId: string, name: string, mimeType: ImageMimeType, bytes: Buffer): Attachment {
      const a: Attachment = { id: randomUUID(), sessionId, name, mimeType, size: bytes.length, createdAt: new Date().toISOString() };
      mkdirSync(join(root, sessionId), { recursive: true, mode: 0o700 });
      writeFileSync(pathOf(a), bytes, { mode: 0o600 });
      store.createAttachment(a);
      return a;
    },
    get: store.getAttachment,
    /** 分叉时把附件文件复制到新会话目录，返回新附件（行由调用方连同会话一起写入）：附件只能被自己会话的消息引用 */
    copyTo(a: Attachment, sessionId: string): Attachment {
      const copy: Attachment = { ...a, id: randomUUID(), sessionId };
      mkdirSync(join(root, sessionId), { recursive: true, mode: 0o700 });
      copyFileSync(pathOf(a), pathOf(copy));
      return copy;
    },
    pathOf,
    /** 删除会话时清掉整个上传目录；行记录由 store.deleteSession 一并删 */
    removeAll(sessionId: string) {
      rmSync(join(root, sessionId), { recursive: true, force: true });
    },
    /** 一条消息引用的附件：每个 id 都必须存在且属于该 session，否则整体拒绝 */
    forMessage(sessionId: string, ids: string[]): Attachment[] {
      return ids.map((id) => {
        const a = store.getAttachment(id);
        if (!a || a.sessionId !== sessionId) throw new Error(`Attachment ${id} not found or belongs to another session`);
        return a;
      });
    },
    read(a: Attachment): Buffer {
      return readFileSync(pathOf(a));
    },
  };
}

export type AttachmentStore = ReturnType<typeof createAttachmentStore>;
