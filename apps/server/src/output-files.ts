import { open, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { HubError } from './hub';

const media: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm' };

// 输出文件按用户授权可在任意目录；不改变 cwd allowlist 或上传附件的边界。
export async function outputFile(cwd: string, input: string, readText = true) {
  if (input.includes('\0')) throw new HubError(400, 'Invalid path');
  const path = resolve(cwd, input.startsWith('~/') ? resolve(homedir(), input.slice(2)) : input);
  try {
    const info = await stat(path);
    if (!info.isFile() && !info.isDirectory()) throw new HubError(400, 'Not a regular file');
    const mime = media[extname(path).toLowerCase()] ?? 'application/octet-stream';
    let kind = info.isDirectory() ? 'directory' : mime.startsWith('image/') ? 'image' : mime === 'application/pdf' ? 'pdf' : mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : 'binary';
    let content: string | null = null;
    let truncated = false;
    if (kind === 'binary' && readText) {
      const file = await open(path, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(info.size, 512 * 1024));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        const bytes = buffer.subarray(0, bytesRead);
        try {
          if (!bytes.includes(0)) {
            content = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: info.size > bytesRead });
            kind = /\.(md|mdx|markdown|mdown)$/i.test(path) ? 'markdown' : 'text';
            truncated = info.size > bytesRead;
          }
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
        }
      } finally { await file.close(); }
    }
    return { path, name: basename(path), size: info.size, mime, kind, content, truncated };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new HubError(404, 'File not found');
    if (code === 'EACCES' || code === 'EPERM') throw new HubError(403, 'macOS denied access to this file');
    throw error;
  }
}
