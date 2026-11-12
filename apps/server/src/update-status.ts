import { readFileSync } from 'node:fs';
import type { UpdateStatus } from '@mindeck/shared';

export function readUpdateStatus(path: string): UpdateStatus | null {
  let status: UpdateStatus;
  try { status = JSON.parse(readFileSync(path, 'utf8')) as UpdateStatus; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (status.phase !== 'completed' && status.phase !== 'failed') {
    try { process.kill(status.pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      return { ...status, phase: 'failed', error: 'Update process stopped before completion. Check the update log.' };
    }
  }
  return status;
}
