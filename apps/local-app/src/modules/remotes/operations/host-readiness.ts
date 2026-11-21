import { homeIdentity } from '../home-identity';
import { HOST_API_KEY_REJECTED, HOST_API_KEY_REJECTED_MESSAGE } from '../host-api-key';
import type { RemoteHealthState } from '../ports/remote-health.port';
import { RemoteOperationStepRefusedError } from './remote-operation.errors';

/**
 * The VM checks before file sync starts with it: it is online, takes this PC's API key, runs
 * this version, and has this PC's home path, so absolute paths mean the same on both sides.
 */
export function assertHostReady(remoteId: string, health: RemoteHealthState): void {
  if (!health.online) {
    throw new RemoteOperationStepRefusedError('REMOTE_OFFLINE', 'The remote is offline.', {
      remoteId,
    });
  }
  if (health.apiKeyRejected) {
    throw new RemoteOperationStepRefusedError(
      HOST_API_KEY_REJECTED,
      HOST_API_KEY_REJECTED_MESSAGE,
      {
        remoteId,
      },
    );
  }
  if (!health.versionMatches) {
    throw new RemoteOperationStepRefusedError(
      'REMOTE_VERSION_MISMATCH',
      `The remote runs version ${health.version ?? 'unknown'}, which differs from this instance.`,
      { remoteId, version: health.version },
    );
  }
  // Only a reported home is compared: a build without the field is older, and
  // the version gate above refuses it.
  const home = homeIdentity().homePath;
  if (typeof health.homePath === 'string' && health.homePath !== home) {
    throw new RemoteOperationStepRefusedError(
      'REMOTE_HOME_MISMATCH',
      `The remote's home folder is ${health.homePath}, but this PC's is ${home}. ` +
        'The VM identity must match this PC; claim the VM again with this PC user.',
      { remoteId, homePath: health.homePath },
    );
  }
}
