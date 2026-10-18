import { readFile } from 'node:fs/promises';
import { posix as path } from 'node:path';
import type { ProviderAuthClaimFile } from '../../provider-auth/provider-auth-adapters';
import { MAX_FILE_BYTES } from '../host/host-provider-auth.service';

/**
 * The VM's `~/.claude/CLAUDE.md` with this PC's file, or null when this PC has
 * none. A symlink is followed and an empty file is sent as is, so it clears the
 * VM's copy. Throws when the file is over the VM's size limit; any other read
 * error propagates. The content may be private and must never be logged.
 */
export async function buildClaudeUserInstructionsFile(
  homePath: string,
): Promise<ProviderAuthClaimFile | null> {
  const filePath = path.join(homePath, '.claude', 'CLAUDE.md');
  let content: Buffer;
  try {
    content = await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (content.length > MAX_FILE_BYTES) {
    throw new Error(`~/.claude/CLAUDE.md is larger than ${MAX_FILE_BYTES / 1024} KiB`);
  }
  return { path: filePath, mode: '0600', contentBase64: content.toString('base64') };
}
