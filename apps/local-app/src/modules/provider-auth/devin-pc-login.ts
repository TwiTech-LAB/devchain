import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { DEVIN_STANDARD_SERVER_URLS } from './provider-auth-adapters';

/** Fixed wording: a result never carries file content, the key or a parser message. */
export type DevinPcLogin =
  | { outcome: 'found'; apiKey: string }
  | { outcome: 'missing'; path: string }
  | { outcome: 'unreadable'; path: string }
  | { outcome: 'invalid' }
  | { outcome: 'no-key' }
  | { outcome: 'other-servers' };

export const DEVIN_PC_LOGIN_PATH_RULE =
  '$XDG_DATA_HOME/devin/credentials.toml, or ~/.local/share/devin/credentials.toml when XDG_DATA_HOME is not set';

/** Where this PC's Devin CLI keeps its login, by the XDG data-folder rule Devin follows. */
export function devinPcCredentialsPath(env: NodeJS.ProcessEnv, homedir: string): string {
  const dataHome = env.XDG_DATA_HOME || join(homedir, '.local/share');
  return join(dataHome, 'devin/credentials.toml');
}

/**
 * Reads the Devin login of this PC. A server key that is absent means Devin's
 * default, which is the standard address; a present key must match it exactly.
 */
export async function readDevinPcLogin(
  env: NodeJS.ProcessEnv,
  homedir: string,
): Promise<DevinPcLogin> {
  const path = devinPcCredentialsPath(env, homedir);
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    // Only a file that does not exist is "missing"; EACCES or EISDIR means it exists.
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return { outcome: missing ? 'missing' : 'unreadable', path };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parse(content);
  } catch {
    return { outcome: 'invalid' };
  }
  const apiKey = parsed.windsurf_api_key;
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) return { outcome: 'no-key' };
  for (const [key, url] of Object.entries(DEVIN_STANDARD_SERVER_URLS)) {
    if (key in parsed && parsed[key] !== url) return { outcome: 'other-servers' };
  }
  return { outcome: 'found', apiKey };
}
