import { createHash, randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';

/** The error code a claimed host answers with when a request lacks its API key. */
export const HOST_API_KEY_REJECTED = 'HOST_API_KEY_REJECTED';

/** Why a step refuses a VM that rejects this PC's API key, and how to fix it. */
export const HOST_API_KEY_REJECTED_MESSAGE =
  "The VM rejected this PC's API key. Use Enter API key in Remote VMs.";

/** A host API key: `dck_` and the base64url form of 32 random bytes. */
export const HOST_API_KEY_PATTERN = /^dck_[A-Za-z0-9_-]{43}$/;

export function generateHostApiKey(): string {
  return `dck_${randomBytes(32).toString('base64url')}`;
}

/** The lowercase hex SHA-256 that a host stores in place of its key. */
export function hashHostApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** True when a host refused the request for a missing or wrong API key. Reads the body of a 401. */
export async function isHostApiKeyRejection(
  response: Pick<Response, 'status' | 'json'>,
): Promise<boolean> {
  if (response.status !== 401) return false;
  const body: unknown = await response.json().catch(() => null);
  return (
    typeof body === 'object' &&
    body !== null &&
    'code' in body &&
    body.code === HOST_API_KEY_REJECTED
  );
}

/**
 * Whether `etcDir/claim.json` marks this instance as a claimed VM. Only absence
 * identifies a home instance; unreadable host state counts as claimed. TLS and
 * VM API key admission both decide "claimed" here.
 */
export function isClaimedHost(etcDir: string): boolean {
  try {
    statSync(join(etcDir, 'claim.json'));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}
