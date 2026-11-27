import { createHash } from 'node:crypto';
import type { IntegrationProvider } from '../../models/domain.models';

/** The host route's bound on `idempotencyKey`. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

/**
 * The key a vendor-task import stores in the epic's `data.idempotencyKey`.
 * Parts are URI-encoded so a `:` inside one cannot collide with the separator;
 * a key past the host's bound falls back to a digest of the same parts.
 */
export function externalImportIdempotencyKey(
  provider: IntegrationProvider,
  remoteScopeKey: string,
  remoteTaskId: string,
): string {
  const key = `import:${provider}:${encodeURIComponent(remoteScopeKey)}:${encodeURIComponent(remoteTaskId)}`;
  if (key.length <= MAX_IDEMPOTENCY_KEY_LENGTH) return key;
  const digest = createHash('sha256').update(`${remoteScopeKey}\n${remoteTaskId}`).digest('hex');
  return `import:${provider}:sha256:${digest}`;
}
