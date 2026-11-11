import { ConflictError } from '../../common/errors/error-types';
import type { SessionRowStore } from '../storage/sessions/session-row.store';
import type { VaultSessionValueStore } from '../vault/vault-session-values';
import type { VaultRequest } from './vault-request.store';

/** The refusal of a session-only answer whose asking session is not running. */
export function vaultRequestSessionEnded(): ConflictError {
  return new ConflictError('The session that asked has stopped.', {
    code: 'VAULT_REQUEST_SESSION_ENDED',
  });
}

/**
 * Gives a session-only answer to the asking session, on the instance that runs it.
 * Refuses with 409 `VAULT_REQUEST_SESSION_ENDED` and stores nothing when that session
 * is not running. Run it as the store's claimed `work`, after the value passed
 * `assertVaultEntryValue`.
 */
export function putVaultRequestSessionValue(
  sessionRows: Pick<SessionRowStore, 'getSession'>,
  sessionValues: Pick<VaultSessionValueStore, 'set'>,
  request: VaultRequest,
  value: string,
): void {
  if (sessionRows.getSession(request.sessionId)?.status !== 'running') {
    throw vaultRequestSessionEnded();
  }
  sessionValues.set(request.sessionId, {
    name: request.name,
    kind: request.kind,
    description: request.description,
    value: Buffer.from(value, 'utf8'),
  });
}
