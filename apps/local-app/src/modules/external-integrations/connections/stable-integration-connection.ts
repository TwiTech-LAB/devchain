import { BusyError, ConflictError, ValidationError } from '../../../common/errors/error-types';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type {
  IntegrationConnection,
  IntegrationCredentials,
  IntegrationProvider,
} from '../../storage/models/domain.models';

type StableConnectionStorage = Pick<
  StorageService,
  'getProject' | 'getIntegrationConnection' | 'getIntegrationConnectionCredentials'
>;

export async function loadStableIntegrationConnection(
  storage: StableConnectionStorage,
  options: {
    projectId: string;
    provider: IntegrationProvider;
    expectedEpoch?: number;
    notConnectedMessage: string;
    connectionChangedMessage: string;
  },
): Promise<{
  connection: IntegrationConnection;
  credentials: IntegrationCredentials;
}> {
  const { projectId, provider, expectedEpoch, notConnectedMessage, connectionChangedMessage } =
    options;
  await storage.getProject(projectId);
  const identity = { projectId, provider } as const;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await storage.getIntegrationConnection(identity);
    if (!matchesScope(before, projectId, provider)) {
      throw notConnected(notConnectedMessage, projectId, provider);
    }
    if (expectedEpoch !== undefined && before.generation !== expectedEpoch) {
      throw epochMismatch(projectId, provider, expectedEpoch, before.generation);
    }

    const credentials = await storage.getIntegrationConnectionCredentials(identity);
    const after = await storage.getIntegrationConnection(identity);
    if (
      !credentials ||
      credentials.provider !== provider ||
      !matchesScope(after, projectId, provider)
    ) {
      throw notConnected(notConnectedMessage, projectId, provider);
    }
    if (expectedEpoch !== undefined && after.generation !== expectedEpoch) {
      throw epochMismatch(projectId, provider, expectedEpoch, after.generation);
    }
    if (before.id === after.id && before.generation === after.generation) {
      return { connection: after, credentials };
    }
  }

  throw new BusyError(connectionChangedMessage, {
    provider,
    projectId,
    reason: 'connection_changed',
  });
}

function matchesScope(
  connection: IntegrationConnection | null,
  projectId: string,
  provider: IntegrationProvider,
): connection is IntegrationConnection & { projectId: string } {
  return connection?.projectId === projectId && connection.provider === provider;
}

function notConnected(
  message: string,
  projectId: string,
  provider: IntegrationProvider,
): ValidationError {
  return new ValidationError(message, {
    provider,
    projectId,
    reason: 'not_connected',
  });
}

function epochMismatch(
  projectId: string,
  provider: IntegrationProvider,
  expectedEpoch: number,
  currentEpoch: number,
): ConflictError {
  return new ConflictError('The connection changed; reload and retry with the current epoch.', {
    provider,
    projectId,
    reason: 'connection_epoch_mismatch',
    expectedEpoch,
    currentEpoch,
  });
}
