import { BusyError, ConflictError, ValidationError } from '../../../common/errors/error-types';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type {
  IntegrationConnection,
  IntegrationCredentials,
  IntegrationProvider,
} from '../../storage/models/domain.models';
import { loadStableIntegrationConnection } from './stable-integration-connection';

// Module-unit layer: storage reads are scripted through the existing interface because this
// suite verifies acquisition orchestration; persistence and encryption remain in storage suites.

const PROJECT_ID = 'project-1';
const NOT_CONNECTED_MESSAGE = 'Connect the integration before loading My Work.';
const CONNECTION_CHANGED_MESSAGE = 'Integration connection changed during My Work refresh.';

type TestStorage = jest.Mocked<
  Pick<
    StorageService,
    'getProject' | 'getIntegrationConnection' | 'getIntegrationConnectionCredentials'
  >
>;

function makeConnection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    id: 'connection-1',
    projectId: PROJECT_ID,
    provider: 'clickup',
    legacySourceConnectionId: null,
    generation: 1,
    subtaskSyncEnabled: false,
    syncSettingRevision: 0,
    createdAt: '2026-08-19T10:00:00.000Z',
    updatedAt: '2026-08-19T11:00:00.000Z',
    ...overrides,
  };
}

function makeCredentials(
  provider: IntegrationProvider = 'clickup',
  token = 'token-1',
): IntegrationCredentials {
  return provider === 'clickup'
    ? { provider, token }
    : { provider, siteUrl: 'https://test.atlassian.net', email: 'user@example.com', token };
}

function setup(): TestStorage {
  return {
    getProject: jest.fn().mockResolvedValue({ id: PROJECT_ID }),
    getIntegrationConnection: jest.fn(),
    getIntegrationConnectionCredentials: jest.fn(),
  };
}

function acquire(
  storage: TestStorage,
  overrides: Partial<{
    projectId: string;
    provider: IntegrationProvider;
    expectedEpoch?: number;
    notConnectedMessage: string;
    connectionChangedMessage: string;
  }> = {},
) {
  return loadStableIntegrationConnection(storage, {
    projectId: PROJECT_ID,
    provider: 'clickup',
    notConnectedMessage: NOT_CONNECTED_MESSAGE,
    connectionChangedMessage: CONNECTION_CHANGED_MESSAGE,
    ...overrides,
  });
}

describe('loadStableIntegrationConnection', () => {
  it('reads the project first, uses one exact scope, and returns the stable after pair', async () => {
    const storage = setup();
    const before = makeConnection({ generation: 7 });
    const after = makeConnection({ generation: 7, updatedAt: '2026-08-19T12:00:00.000Z' });
    const credentials = makeCredentials('clickup', 'stable-token');
    let resolveCredentials!: (value: IntegrationCredentials) => void;
    const pendingCredentials = new Promise<IntegrationCredentials>((resolve) => {
      resolveCredentials = resolve;
    });
    let markCredentialReadStarted!: () => void;
    const credentialReadStarted = new Promise<void>((resolve) => {
      markCredentialReadStarted = resolve;
    });
    storage.getIntegrationConnection.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    storage.getIntegrationConnectionCredentials.mockImplementation(() => {
      markCredentialReadStarted();
      return pendingCredentials;
    });

    const acquisition = acquire(storage);
    await credentialReadStarted;
    expect(storage.getIntegrationConnection).toHaveBeenCalledTimes(1);
    resolveCredentials(credentials);
    await expect(acquisition).resolves.toEqual({ connection: after, credentials });

    const identity = { projectId: PROJECT_ID, provider: 'clickup' };
    expect(storage.getProject).toHaveBeenCalledTimes(1);
    expect(storage.getProject).toHaveBeenCalledWith(PROJECT_ID);
    expect(storage.getIntegrationConnection).toHaveBeenCalledTimes(2);
    expect(storage.getIntegrationConnection).toHaveBeenNthCalledWith(1, identity);
    expect(storage.getIntegrationConnectionCredentials).toHaveBeenCalledTimes(1);
    expect(storage.getIntegrationConnectionCredentials).toHaveBeenCalledWith(identity);
    expect(storage.getIntegrationConnection).toHaveBeenNthCalledWith(2, identity);
    expect(storage.getProject.mock.invocationCallOrder[0]).toBeLessThan(
      storage.getIntegrationConnection.mock.invocationCallOrder[0],
    );
    expect(storage.getIntegrationConnection.mock.invocationCallOrder[0]).toBeLessThan(
      storage.getIntegrationConnectionCredentials.mock.invocationCallOrder[0],
    );
    expect(storage.getIntegrationConnectionCredentials.mock.invocationCallOrder[0]).toBeLessThan(
      storage.getIntegrationConnection.mock.invocationCallOrder[1],
    );
  });

  it('rejects a missing or wrong-scope before state before reading credentials', async () => {
    const cases: Array<{ name: string; before: IntegrationConnection | null }> = [
      { name: 'missing connection', before: null },
      {
        name: 'wrong project',
        before: makeConnection({ projectId: 'project-2' }),
      },
      {
        name: 'wrong provider',
        before: makeConnection({ provider: 'jira' }),
      },
    ];

    for (const { before } of cases) {
      const storage = setup();
      storage.getIntegrationConnection.mockResolvedValue(before);

      const error = await acquire(storage).then<unknown>(
        () => undefined,
        (rejection: unknown) => rejection,
      );
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({
        message: NOT_CONNECTED_MESSAGE,
        code: 'validation_error',
        statusCode: 400,
        details: { provider: 'clickup', projectId: PROJECT_ID, reason: 'not_connected' },
      });
      expect(storage.getIntegrationConnectionCredentials).not.toHaveBeenCalled();
      expect(storage.getIntegrationConnection).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    {
      name: 'null credentials',
      credentials: null,
      after: makeConnection(),
    },
    {
      name: 'wrong-provider credentials',
      credentials: makeCredentials('jira'),
      after: makeConnection(),
    },
    {
      name: 'missing after state',
      credentials: makeCredentials(),
      after: null,
    },
    {
      name: 'wrong-scope after state',
      credentials: makeCredentials(),
      after: makeConnection({ projectId: 'project-2' }),
    },
  ])('rejects $name after completing the after read', async ({ credentials, after }) => {
    const storage = setup();
    storage.getIntegrationConnection
      .mockResolvedValueOnce(makeConnection())
      .mockResolvedValueOnce(after);
    storage.getIntegrationConnectionCredentials.mockResolvedValue(credentials);

    await expect(acquire(storage)).rejects.toMatchObject({
      message: NOT_CONNECTED_MESSAGE,
      details: { reason: 'not_connected' },
    });
    expect(storage.getIntegrationConnection).toHaveBeenCalledTimes(2);
    expect(storage.getIntegrationConnectionCredentials).toHaveBeenCalledTimes(1);
  });

  it('allows an undefined expected epoch and succeeds when a supplied epoch matches', async () => {
    const storage = setup();
    const connection = makeConnection({ generation: 4 });
    storage.getIntegrationConnection.mockResolvedValue(connection);
    storage.getIntegrationConnectionCredentials.mockResolvedValue(makeCredentials());

    await expect(acquire(storage)).resolves.toMatchObject({ connection });
    await expect(acquire(storage, { expectedEpoch: 4 })).resolves.toMatchObject({ connection });
  });

  it('rejects a before-read epoch mismatch before credentials', async () => {
    const storage = setup();
    storage.getIntegrationConnection.mockResolvedValue(makeConnection({ generation: 5 }));

    const error = await acquire(storage, { expectedEpoch: 4 }).then<unknown>(
      () => undefined,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({
      message: 'The connection changed; reload and retry with the current epoch.',
      code: 'conflict',
      statusCode: 409,
      details: {
        provider: 'clickup',
        projectId: PROJECT_ID,
        reason: 'connection_epoch_mismatch',
        expectedEpoch: 4,
        currentEpoch: 5,
      },
    });
    expect(storage.getIntegrationConnectionCredentials).not.toHaveBeenCalled();
  });

  it('rejects an after-read epoch mismatch without retrying', async () => {
    const storage = setup();
    storage.getIntegrationConnection
      .mockResolvedValueOnce(makeConnection({ generation: 4 }))
      .mockResolvedValueOnce(makeConnection({ generation: 5 }));
    storage.getIntegrationConnectionCredentials.mockResolvedValue(makeCredentials());

    const error = await acquire(storage, { expectedEpoch: 4 }).then<unknown>(
      () => undefined,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({
      details: { reason: 'connection_epoch_mismatch', expectedEpoch: 4, currentEpoch: 5 },
    });
    expect(storage.getIntegrationConnection).toHaveBeenCalledTimes(2);
    expect(storage.getIntegrationConnectionCredentials).toHaveBeenCalledTimes(1);
  });

  it('gives invalid credentials precedence over an after-read epoch mismatch', async () => {
    const storage = setup();
    storage.getIntegrationConnection
      .mockResolvedValueOnce(makeConnection({ generation: 4 }))
      .mockResolvedValueOnce(makeConnection({ generation: 5 }));
    storage.getIntegrationConnectionCredentials.mockResolvedValue(null);

    const error = await acquire(storage, { expectedEpoch: 4 }).then<unknown>(
      () => undefined,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ details: { reason: 'not_connected' } });
    expect(storage.getIntegrationConnection).toHaveBeenCalledTimes(2);
  });

  it('propagates a rejected credential read before attempting the after read', async () => {
    const storage = setup();
    const failure = new Error('credential read failed');
    storage.getIntegrationConnection.mockResolvedValue(makeConnection());
    storage.getIntegrationConnectionCredentials.mockRejectedValue(failure);

    await expect(acquire(storage)).rejects.toBe(failure);
    expect(storage.getIntegrationConnection).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'id-only replacement', firstAfter: { id: 'connection-2', generation: 1 } },
    { name: 'generation-only replacement', firstAfter: { id: 'connection-1', generation: 2 } },
  ])(
    'retries a $name and returns fresh credentials from the stable attempt',
    async ({ firstAfter }) => {
      const storage = setup();
      const before = makeConnection();
      const unstableAfter = makeConnection(firstAfter);
      const replacement = makeConnection({ ...firstAfter });
      const firstCredentials = makeCredentials('clickup', 'old-token');
      const replacementCredentials = makeCredentials('clickup', 'replacement-token');
      storage.getIntegrationConnection
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(unstableAfter)
        .mockResolvedValueOnce(replacement)
        .mockResolvedValueOnce(replacement);
      storage.getIntegrationConnectionCredentials
        .mockResolvedValueOnce(firstCredentials)
        .mockResolvedValueOnce(replacementCredentials);

      await expect(acquire(storage)).resolves.toEqual({
        connection: replacement,
        credentials: replacementCredentials,
      });
      expect(storage.getIntegrationConnection).toHaveBeenCalledTimes(4);
      expect(storage.getIntegrationConnectionCredentials).toHaveBeenCalledTimes(2);
    },
  );

  it('fails with BusyError after exactly three unstable attempts', async () => {
    const storage = setup();
    storage.getIntegrationConnection
      .mockResolvedValueOnce(makeConnection({ generation: 1 }))
      .mockResolvedValueOnce(makeConnection({ generation: 2 }))
      .mockResolvedValueOnce(makeConnection({ generation: 2 }))
      .mockResolvedValueOnce(makeConnection({ generation: 3 }))
      .mockResolvedValueOnce(makeConnection({ generation: 3 }))
      .mockResolvedValueOnce(makeConnection({ generation: 4 }));
    storage.getIntegrationConnectionCredentials.mockResolvedValue(makeCredentials());

    const error = await acquire(storage).then<unknown>(
      () => undefined,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(BusyError);
    expect(error).toMatchObject({
      message: CONNECTION_CHANGED_MESSAGE,
      code: 'busy',
      statusCode: 409,
      details: { provider: 'clickup', projectId: PROJECT_ID, reason: 'connection_changed' },
    });
    expect(storage.getIntegrationConnection).toHaveBeenCalledTimes(6);
    expect(storage.getIntegrationConnectionCredentials).toHaveBeenCalledTimes(3);
  });

  it('uses the supplied caller messages while preserving projected error classes', async () => {
    const storage = setup();
    storage.getIntegrationConnection.mockResolvedValue(null);

    const unavailable = await acquire(storage, {
      notConnectedMessage: 'custom unavailable',
      connectionChangedMessage: 'custom changed',
    }).then<unknown>(
      () => undefined,
      (rejection: unknown) => rejection,
    );
    expect(unavailable).toBeInstanceOf(ValidationError);
    expect(unavailable).toMatchObject({ message: 'custom unavailable' });

    const unstable = setup();
    unstable.getIntegrationConnection
      .mockResolvedValueOnce(makeConnection({ generation: 1 }))
      .mockResolvedValueOnce(makeConnection({ generation: 2 }))
      .mockResolvedValueOnce(makeConnection({ generation: 2 }))
      .mockResolvedValueOnce(makeConnection({ generation: 3 }))
      .mockResolvedValueOnce(makeConnection({ generation: 3 }))
      .mockResolvedValueOnce(makeConnection({ generation: 4 }));
    unstable.getIntegrationConnectionCredentials.mockResolvedValue(makeCredentials());
    const changed = await acquire(unstable, {
      notConnectedMessage: 'custom unavailable',
      connectionChangedMessage: 'custom changed',
    }).then<unknown>(
      () => undefined,
      (rejection: unknown) => rejection,
    );
    expect(changed).toBeInstanceOf(BusyError);
    expect(changed).toMatchObject({ message: 'custom changed' });
  });

  it.each([
    {
      name: 'project read',
      configure: (storage: TestStorage, failure: Error) =>
        storage.getProject.mockRejectedValue(failure),
      assert: (storage: TestStorage) => {
        expect(storage.getIntegrationConnection).not.toHaveBeenCalled();
      },
    },
    {
      name: 'before state read',
      configure: (storage: TestStorage, failure: Error) => {
        storage.getIntegrationConnection.mockRejectedValue(failure);
      },
      assert: (storage: TestStorage) => {
        expect(storage.getIntegrationConnectionCredentials).not.toHaveBeenCalled();
      },
    },
    {
      name: 'after state read',
      configure: (storage: TestStorage, failure: Error) => {
        storage.getIntegrationConnection
          .mockResolvedValueOnce(makeConnection())
          .mockRejectedValue(failure);
        storage.getIntegrationConnectionCredentials.mockResolvedValue(makeCredentials());
      },
      assert: (storage: TestStorage) => {
        expect(storage.getIntegrationConnection).toHaveBeenCalledTimes(2);
      },
    },
    {
      name: 'credential read',
      configure: (storage: TestStorage, failure: Error) => {
        storage.getIntegrationConnection.mockResolvedValue(makeConnection());
        storage.getIntegrationConnectionCredentials.mockRejectedValue(failure);
      },
      assert: (storage: TestStorage) => {
        expect(storage.getIntegrationConnection).toHaveBeenCalledTimes(1);
      },
    },
  ])(
    'propagates the same object from a $name failure without retry',
    async ({ configure, assert }) => {
      const storage = setup();
      const failure = new Error('storage failed');
      configure(storage, failure);

      await expect(acquire(storage)).rejects.toBe(failure);
      assert(storage);
    },
  );
});
