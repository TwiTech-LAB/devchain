import { opencodeV2CommandArgs } from '../../providers/adapters/provider-cli-policy';
import {
  DEVCHAIN_OPENCODE_CREDENTIAL_ID_PREFIX,
  toOpencodeV2Credential,
  type OpencodeV2ExportItem,
} from '../../provider-auth/opencode-credentials';

/** Runs `opencode <args>` (stdin from `input`, else /dev/null); `ok` is a zero exit. */
export type OpencodeCliRunner = (
  args: string[],
  input?: string,
) => Promise<{ ok: boolean; stdout: string; output: string }>;

async function runOrThrow(run: OpencodeCliRunner, args: string[], input?: string): Promise<string> {
  const argv = opencodeV2CommandArgs(args);
  const result = await run(argv, input);
  if (!result.ok) {
    throw new Error(`opencode ${argv.join(' ')} failed: ${result.output.trim().slice(-500)}`);
  }
  return result.stdout;
}

async function exportCredentials(run: OpencodeCliRunner): Promise<OpencodeV2ExportItem[]> {
  const parsed: unknown = JSON.parse(await runOrThrow(run, ['auth', 'export']));
  if (!Array.isArray(parsed)) throw new Error('opencode auth export did not print a JSON array');
  return parsed as OpencodeV2ExportItem[];
}

/**
 * Replaces every OpenCode 2 credential with the logins of a v1 `auth.json`, as v1
 * did by overwriting the file. The export comes first: on a v1 DB it runs
 * OpenCode 2's one-time migration, whose rows would otherwise appear after the
 * logouts and leave DevChain's import inactive.
 */
export async function replaceOpencodeCredentialsV2(
  run: OpencodeCliRunner,
  authFileContent: string,
): Promise<string[]> {
  const authFile = JSON.parse(authFileContent) as Record<string, Record<string, unknown>>;
  const items = Object.entries(authFile).map(([providerId, entry]) => ({
    id: `${DEVCHAIN_OPENCODE_CREDENTIAL_ID_PREFIX}${providerId}`,
    integrationID: providerId,
    label: 'DevChain',
    active: true,
    value: toOpencodeV2Credential(providerId, entry),
  }));
  for (const credential of await exportCredentials(run)) {
    await runOrThrow(run, ['auth', 'logout', credential.integrationID, credential.id]);
  }
  await runOrThrow(run, ['auth', 'import'], JSON.stringify(items));
  return items.map((item) => item.integrationID);
}

/** Logs out the credentials DevChain imported; the user's own stay. Returns their providers. */
export async function logoutDevchainOpencodeCredentialsV2(
  run: OpencodeCliRunner,
): Promise<string[]> {
  const removed: string[] = [];
  for (const credential of await exportCredentials(run)) {
    if (!credential.id.startsWith(DEVCHAIN_OPENCODE_CREDENTIAL_ID_PREFIX)) continue;
    await runOrThrow(run, ['auth', 'logout', credential.integrationID, credential.id]);
    removed.push(credential.integrationID);
  }
  return removed;
}
