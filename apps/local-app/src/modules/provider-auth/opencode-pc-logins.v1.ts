import { readFile } from 'node:fs/promises';
import { opencodePcAuthFilePath } from './provider-auth-adapters';

/** The PC's OpenCode 1 `auth.json`; null when it is missing, unreadable, or not a JSON object. */
export async function readOpencodeAuthFileV1(
  homedir: string,
): Promise<Record<string, unknown> | null> {
  let content: string;
  try {
    content = await readFile(opencodePcAuthFilePath(homedir), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}
