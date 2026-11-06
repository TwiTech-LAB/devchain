import { join } from 'node:path';

/**
 * DevChain-owned Devin transcript root. Devin is bound to its transcript at
 * launch via `devin --export <path>` pointed INSIDE DevChain's own directory —
 * unlike the other providers, the file is written by the CLI into our store, so
 * the name is devchain's `sessions.id` (not the provider's session name).
 * The same root is the session-reader's `allowedRoots` entry and the
 * `PROVIDER_ROOTS` validator root (`.devchain/provider-transcripts/devin/`).
 */
export const DEVIN_TRANSCRIPTS_ROOT = '.devchain/provider-transcripts/devin/';

/**
 * `~/.devchain/provider-transcripts/devin/<sessions.id>.json` — the `--export`
 * target for both new launches and restores (`devin -r` writes the FULL
 * conversation to the new path, so the binding survives restores).
 */
export function devinTranscriptPath(homeDir: string, sessionId: string): string {
  return join(homeDir, DEVIN_TRANSCRIPTS_ROOT, `${sessionId}.json`);
}
