import {
  applyProviderCliNoUpdate,
  opencodeV2CommandArgs,
} from '../providers/adapters/provider-cli-policy';
import type { ProcessExecutor } from '../terminal/services/process-executor/process-executor.port';
import { parseOpencodeV2Export, type OpencodeV1Entry } from './opencode-credentials';

const EXPORT_TIMEOUT_MS = 30_000;

/** The PC's OpenCode 2 logins as v1 entries; null when the export fails or prints no export. */
export async function exportOpencodeLoginsV2(
  executor: ProcessExecutor,
  binPath: string,
): Promise<Record<string, OpencodeV1Entry> | null> {
  const command = applyProviderCliNoUpdate(
    'opencode',
    opencodeV2CommandArgs([binPath, 'auth', 'export']),
    process.env,
  );
  const result = await executor.run({
    argv: command.argv,
    mode: 'pipe',
    env: command.env,
    timeout: EXPORT_TIMEOUT_MS,
    outputLimits: { maxBytes: 1024 * 1024 },
  });
  if (!result.success) return null;
  try {
    return parseOpencodeV2Export(result.stdout);
  } catch {
    return null;
  }
}
