import { RemoteApiKeyManagementService } from '../auth/remote-api-key-management.service';
import { RemoteApiKeyService } from '../auth/remote-api-key.service';
import { RemoteFileSyncService } from '../sync/remote-file-sync.service';
import { Test, TestingModule } from '@nestjs/testing';
import { ZodError } from 'zod';
import { NotFoundError } from '../../../common/errors/error-types';
import { fixtureTls } from '../../../common/test/tls-fixture';
import { certificateFingerprint, normalizeCertificate } from '../../../common/tls/certificate';
import { RemotesController } from './remotes.controller';
import { RemotesService } from '../services/remotes.service';
import { RemoteHostClient } from '../operations/remote-host.client';
import { RemoteOperationRunner } from '../operations/remote-operation.runner';
import { ProviderAuthWritebackService } from '../../provider-auth/provider-auth-writeback.service';
import { ProjectWriteAdmissionService } from '../admission/project-write-admission.service';
import { createProjectWriteAdmissionStub } from '../admission/testing/project-write-admission.stub';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { REMOTE_HEALTH_PORT, type RemoteHealthState } from '../ports/remote-health.port';
import type {
  Remote,
  RemoteOperation,
  RemoteProjectBinding,
} from '../../storage/models/domain.models';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

describe('RemotesController', () => {
  let controller: RemotesController;
  const files = {
    problem: jest.fn(() => 'setup'),
    warning: jest.fn(() => null as string | null),
    failedCounts: jest.fn(() => null as { home: number; vm: number } | null),
  };
  let storage: {
    listRemotes: jest.Mock;
    getRemote: jest.Mock;
    createRemote: jest.Mock;
    updateRemoteName: jest.Mock;
    deleteRemote: jest.Mock;
    listRemoteProjectBindings: jest.Mock;
    listRemoteOperations: jest.Mock;
  };
  let remoteHealth: { getState: jest.Mock; getStatsHistory: jest.Mock; refresh: jest.Mock };
  let hostClient: { setInstanceLabel: jest.Mock; discoverRuntime: jest.Mock };
  let familyWriteback: { pullFamiliesNow: jest.Mock };
  let runner: { supersedeFailedVmOperation: jest.Mock };

  const offlineHealth: RemoteHealthState = {
    online: false,
    version: null,
    versionMatches: false,
    homePath: null,
    uid: null,
    gid: null,
    stats: null,
    lastSeenAt: null,
    error: null,
  };

  const pinned = normalizeCertificate(fixtureTls.cert);
  const fingerprint = certificateFingerprint(fixtureTls.cert);

  const mockRemote: Remote = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'home-nas',
    baseUrl: 'https://192.168.1.5:9080',
    kind: 'address',
    vmProviderConnectionId: null,
    vmIdentity: null,
    vmSpec: null,
    tlsCertificate: fixtureTls.cert,
    tlsFingerprint: certificateFingerprint(fixtureTls.cert),
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  const mockDoneClaim: RemoteOperation = {
    id: 'op-claim-1',
    kind: 'claim',
    remoteId: mockRemote.id,
    projectId: null,
    state: 'done',
    steps: [],
    details: { userName: 'devchain', homePath: '/home/devchain' },
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  /** Answers only the claim-kind history query, as the storage would. */
  const claimHistory = (operation: RemoteOperation) => (query: { kinds?: readonly string[] }) =>
    query.kinds ? Promise.resolve([operation]) : Promise.resolve([]);

  const mockBinding: RemoteProjectBinding = {
    projectId: '660e8400-e29b-41d4-a716-446655440001',
    remoteId: mockRemote.id,
    state: 'remote',
    hostCursor: null,
    syncError: null,
    syncFailedAt: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  it.each([null, { home: 3, vm: 7 }])(
    'returns active warnings and matured counts only for remote-owned bindings (counts=%j)',
    async (counts) => {
      storage.listRemoteProjectBindings.mockResolvedValue([
        mockBinding,
        { ...mockBinding, projectId: 'other', state: 'detaching' },
      ]);
      files.warning.mockReturnValue('Retrying file sync');
      files.failedCounts.mockReturnValue(counts);
      const result = await controller.listBindings();
      expect(result.items[0]).toMatchObject({ fileSyncWarning: 'Retrying file sync' });
      expect(result.items[1]).not.toHaveProperty('fileSyncWarning');
      if (counts) expect(result.items[0]).toMatchObject({ fileSyncFailed: counts });
      else expect(result.items[0]).not.toHaveProperty('fileSyncFailed');
      expect(result.items[1]).not.toHaveProperty('fileSyncFailed');
      files.warning.mockReturnValue(null);
      expect((await controller.listBindings()).items[0]).not.toHaveProperty('fileSyncFailed');
    },
  );

  beforeEach(async () => {
    files.warning.mockReturnValue(null);
    files.failedCounts.mockReturnValue(null);
    storage = {
      listRemotes: jest.fn(),
      getRemote: jest.fn(),
      createRemote: jest.fn(),
      updateRemoteName: jest.fn(),
      deleteRemote: jest.fn(),
      listRemoteProjectBindings: jest.fn().mockResolvedValue([]),
      listRemoteOperations: jest.fn().mockResolvedValue([]),
    };
    remoteHealth = {
      getState: jest.fn().mockReturnValue(offlineHealth),
      getStatsHistory: jest.fn(),
      refresh: jest.fn().mockResolvedValue(offlineHealth),
    };
    hostClient = {
      setInstanceLabel: jest.fn().mockResolvedValue(undefined),
      discoverRuntime: jest.fn().mockResolvedValue({ runtime: null, certificate: pinned }),
    };
    familyWriteback = {
      pullFamiliesNow: jest.fn().mockResolvedValue({ pulled: false, families: [] }),
    };
    runner = { supersedeFailedVmOperation: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RemotesController],
      providers: [
        RemotesService,
        {
          provide: RemoteApiKeyManagementService,
          useValue: { validate: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: RemoteApiKeyService,
          useValue: { save: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: RemoteFileSyncService, useValue: files },
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: REMOTE_HEALTH_PORT, useValue: remoteHealth },
        { provide: RemoteHostClient, useValue: hostClient },
        { provide: ProviderAuthWritebackService, useValue: familyWriteback },
        { provide: RemoteOperationRunner, useValue: runner },
        { provide: ProjectWriteAdmissionService, useValue: createProjectWriteAdmissionStub() },
      ],
    }).compile();

    controller = module.get(RemotesController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/remotes', () => {
    it('lists remotes enriched with offline-default health when never polled', async () => {
      storage.listRemotes.mockResolvedValue({
        items: [mockRemote],
        total: 1,
        limit: 100,
        offset: 0,
      });

      const result = await controller.listRemotes();

      expect(storage.listRemotes).toHaveBeenCalled();
      expect(remoteHealth.getState).toHaveBeenCalledWith(mockRemote.id);
      expect(result.items).toEqual([
        {
          ...mockRemote,
          online: false,
          apiKeyRejected: false,
          version: null,
          versionMatches: false,
          uid: null,
          gid: null,
          dockerUserMismatch: null,
          stats: null,
          lastSeenAt: null,
          homePath: null,
          homePathMatches: null,
          lastOperation: null,
          userName: null,
          logins: null,
        },
      ]);
    });

    it('returns the userName of the latest done claim-kind operation', async () => {
      storage.listRemotes.mockResolvedValue({
        items: [mockRemote],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.listRemoteOperations.mockImplementation(claimHistory(mockDoneClaim));

      const result = await controller.listRemotes();

      expect(result.items[0].userName).toBe('devchain');
    });

    it('returns a null userName for a legacy claim-kind record without the field', async () => {
      storage.listRemotes.mockResolvedValue({
        items: [mockRemote],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.listRemoteOperations.mockImplementation(
        claimHistory({ ...mockDoneClaim, details: {} }),
      );

      const result = await controller.listRemotes();

      expect(result.items[0].userName).toBeNull();
    });
  });

  describe('GET /api/remotes/:id/stats/history', () => {
    const historySample = (cpuPercent: number) => ({
      cpuPercent,
      load1: 0.1,
      load5: 0.2,
      memTotalBytes: 1000,
      memUsedBytes: 500,
      diskTotalBytes: 2000,
      diskUsedBytes: 1000,
      uptimeSec: 60,
      sampledAt: `2024-01-01T00:00:0${cpuPercent}.000Z`,
    });

    it('returns samples oldest first with the poll interval', async () => {
      storage.getRemote.mockResolvedValue(mockRemote);
      const samples = [historySample(1), historySample(2), historySample(3)];
      remoteHealth.getStatsHistory.mockReturnValue(samples);

      const result = await controller.getStatsHistory(mockRemote.id);

      expect(storage.getRemote).toHaveBeenCalledWith(mockRemote.id);
      expect(remoteHealth.getStatsHistory).toHaveBeenCalledWith(mockRemote.id);
      expect(result).toEqual({ intervalMs: 10000, samples });
    });

    it('rejects with a 404-shaped NotFoundError for an unknown remote id', async () => {
      storage.getRemote.mockRejectedValue(new NotFoundError('Remote', mockRemote.id));

      await expect(controller.getStatsHistory(mockRemote.id)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(remoteHealth.getStatsHistory).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/remotes', () => {
    it('creates a remote pinned to the certificate that matches the pasted fingerprint', async () => {
      storage.createRemote.mockResolvedValue(mockRemote);

      const result = await controller.createRemote({
        name: 'home-nas',
        baseUrl: 'https://192.168.1.5:9080',
        certificateFingerprint: fingerprint.toLowerCase().match(/../g)!.join(':'),
      });

      expect(hostClient.discoverRuntime).toHaveBeenCalledWith('https://192.168.1.5:9080');
      expect(storage.createRemote).toHaveBeenCalledWith({
        name: 'home-nas',
        baseUrl: 'https://192.168.1.5:9080',
        kind: 'address',
        tlsCertificate: pinned,
      });
      expect(result).toEqual(mockRemote);
    });

    it.each([
      ['openssl', 'sha256 Fingerprint='],
      ['the install block', 'Certificate fingerprint (SHA-256): '],
    ])('accepts the fingerprint line that %s prints', async (_source, label) => {
      storage.createRemote.mockResolvedValue(mockRemote);

      await controller.createRemote({
        name: 'home-nas',
        baseUrl: 'https://192.168.1.5:9080',
        certificateFingerprint: `${label}${fingerprint.match(/../g)!.join(':')}\n`,
      });

      expect(storage.createRemote).toHaveBeenCalled();
    });

    it.each([
      ['no fingerprint', undefined],
      ['a short fingerprint', 'AB:CD'],
      ['a non-hex fingerprint', 'Z'.repeat(64)],
      ['a certificate in place of a fingerprint', fixtureTls.cert],
    ])('rejects %s before contacting the VM', (_label, certificateFingerprint) => {
      expect(() =>
        controller.createRemote({
          name: 'home-nas',
          baseUrl: 'https://192.168.1.5:9080',
          certificateFingerprint,
        }),
      ).toThrow(ZodError);
      expect(hostClient.discoverRuntime).not.toHaveBeenCalled();
      expect(storage.createRemote).not.toHaveBeenCalled();
    });

    it('rejects the removed tlsCertificate field', () => {
      expect(() =>
        controller.createRemote({
          name: 'home-nas',
          baseUrl: 'https://192.168.1.5:9080',
          certificateFingerprint: fingerprint,
          tlsCertificate: fixtureTls.cert,
        }),
      ).toThrow(ZodError);
    });

    it('starts a health refresh of the new remote without waiting for it', async () => {
      storage.createRemote.mockResolvedValue(mockRemote);
      remoteHealth.refresh.mockReturnValue(new Promise(() => undefined));

      const result = await controller.createRemote({
        name: 'home-nas',
        baseUrl: 'https://192.168.1.5:9080',
        certificateFingerprint: fingerprint,
      });

      expect(result).toEqual(mockRemote);
      expect(remoteHealth.refresh).toHaveBeenCalledWith(mockRemote.id);
    });

    it('still answers the create when the health refresh fails', async () => {
      storage.createRemote.mockResolvedValue(mockRemote);
      remoteHealth.refresh.mockRejectedValue(new Error('host unreachable'));

      await expect(
        controller.createRemote({
          name: 'home-nas',
          baseUrl: 'https://192.168.1.5:9080',
          certificateFingerprint: fingerprint,
        }),
      ).resolves.toEqual(mockRemote);
    });

    it('rejects a baseUrl with a path', () => {
      expect(() =>
        controller.createRemote({ name: 'home-nas', baseUrl: 'https://192.168.1.5/foo' }),
      ).toThrow(ZodError);
      expect(storage.createRemote).not.toHaveBeenCalled();
    });

    it('accepts an IPv6 literal and stores the normalised origin', async () => {
      storage.createRemote.mockResolvedValue(mockRemote);

      await controller.createRemote({
        name: 'v6',
        baseUrl: ' https://[::1]:4000/ ',
        certificateFingerprint: fingerprint,
      });

      expect(storage.createRemote).toHaveBeenCalledWith({
        name: 'v6',
        baseUrl: 'https://[::1]:4000',
        kind: 'address',
        tlsCertificate: pinned,
      });
    });

    it.each([
      ['an impossible port', 'https://host:99999'],
      ['credentials', 'https://user:pw@host:4000'],
      ['a query string', 'https://host:4000?x=1'],
      ['a non-http scheme', 'ftp://host:4000'],
      ['plain http', 'http://host:4000'],
    ])('rejects a baseUrl with %s', (_label, baseUrl) => {
      expect(() => controller.createRemote({ name: 'home-nas', baseUrl })).toThrow(ZodError);
      expect(storage.createRemote).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /api/remotes/:id', () => {
    it('re-sends the new name as the remote instance label so the phone stays aligned', async () => {
      storage.updateRemoteName.mockResolvedValue({ ...mockRemote, name: 'renamed' });

      await controller.updateRemoteName(mockRemote.id, { name: 'renamed' });

      expect(hostClient.setInstanceLabel).toHaveBeenCalledWith(mockRemote.id, 'renamed');
    });

    it('keeps the rename when the label push fails', async () => {
      storage.updateRemoteName.mockResolvedValue({ ...mockRemote, name: 'renamed' });
      hostClient.setInstanceLabel.mockRejectedValue(new Error('host unreachable'));

      const result = await controller.updateRemoteName(mockRemote.id, { name: 'renamed' });

      expect(result.name).toBe('renamed');
    });
  });

  describe('DELETE /api/remotes/:id', () => {
    it('refuses deletion while VM creation is open', async () => {
      runner.supersedeFailedVmOperation.mockRejectedValueOnce(
        Object.assign(new Error('VM creation is open'), { statusCode: 409 }),
      );
      await expect(controller.deleteRemote(mockRemote.id)).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(storage.deleteRemote).not.toHaveBeenCalled();
    });

    it('pulls refreshed login families from the remote before deleting it', async () => {
      storage.deleteRemote.mockResolvedValue(undefined);

      await controller.deleteRemote(mockRemote.id);

      expect(familyWriteback.pullFamiliesNow).toHaveBeenCalledWith(mockRemote.id);
      expect(storage.deleteRemote).toHaveBeenCalledWith(mockRemote.id);
    });

    it('still deletes when the family pull fails on a reachable-looking row', async () => {
      storage.deleteRemote.mockResolvedValue(undefined);
      familyWriteback.pullFamiliesNow.mockRejectedValue(new Error('host unreachable'));

      await controller.deleteRemote(mockRemote.id);

      expect(storage.deleteRemote).toHaveBeenCalledWith(mockRemote.id);
    });
  });
});
