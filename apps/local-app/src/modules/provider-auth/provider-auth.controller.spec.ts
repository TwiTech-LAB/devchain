import { Test, TestingModule } from '@nestjs/testing';
import { ZodError } from 'zod';

import { STORAGE_SERVICE } from '../storage/interfaces/storage.interface';
import { ProviderAuthController } from './provider-auth.controller';
import { ProviderAuthReleaseService } from './provider-auth-release.service';
import { ProviderAuthVaultService } from './provider-auth-vault.service';
import { ProviderAuthGeneratorService } from './provider-auth-generator.service';

const ENTRY = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'claude',
  kind: 'static' as const,
  label: 'Claude token',
  payloadKind: 'env' as const,
  checkedOutRemoteId: null,
  createdAt: '2026-09-24T00:00:00.000Z',
  updatedAt: '2026-09-24T00:00:00.000Z',
  lastVerifiedAt: null,
  lastWritebackAt: null,
};

describe('ProviderAuthController', () => {
  let controller: ProviderAuthController;
  let vault: {
    list: jest.Mock;
    createStatic: jest.Mock;
    importOpencode: jest.Mock;
    listOpencodeLogins: jest.Mock;
    delete: jest.Mock;
    checkout: jest.Mock;
    rename: jest.Mock;
  };
  let releaseService: { release: jest.Mock };
  let generator: { start: jest.Mock; get: jest.Mock; cancel: jest.Mock };
  const GENERATION = {
    id: '33333333-3333-4333-8333-333333333333',
    provider: 'codex',
    sessionId: '44444444-4444-4444-8444-444444444444',
    state: 'waiting',
    startedAt: '2026-09-24T00:00:00.000Z',
    finishedAt: null,
    entries: [],
    error: null,
  };

  beforeEach(async () => {
    vault = {
      list: jest.fn().mockResolvedValue([ENTRY]),
      createStatic: jest.fn().mockResolvedValue(ENTRY),
      importOpencode: jest.fn().mockResolvedValue([]),
      listOpencodeLogins: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue(undefined),
      checkout: jest.fn().mockResolvedValue(ENTRY),
      rename: jest.fn().mockResolvedValue(ENTRY),
    };
    releaseService = {
      release: jest.fn().mockResolvedValue({ entry: ENTRY, pullStatus: 'pulled' }),
    };
    generator = {
      start: jest.fn().mockResolvedValue(GENERATION),
      get: jest.fn().mockReturnValue(GENERATION),
      cancel: jest.fn().mockResolvedValue({ ...GENERATION, state: 'cancelled' }),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProviderAuthController],
      providers: [
        { provide: ProviderAuthVaultService, useValue: vault },
        { provide: ProviderAuthReleaseService, useValue: releaseService },
        { provide: ProviderAuthGeneratorService, useValue: generator },
        { provide: STORAGE_SERVICE, useValue: {} },
        { provide: 'ProviderAdapterFactory', useValue: {} },
      ],
    }).compile();
    controller = module.get(ProviderAuthController);
  });

  // The controller exercises the request schema without needing an HTTP server.

  // Module unit: the REST boundary must preserve the shared group id and per-id outcomes.

  it('rejects malformed bodies at the REST boundary', async () => {
    await expect(
      controller.createStatic({ provider: 'claude', label: 'L', token: 'line\nbreak' }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      controller.createStatic({ provider: 'claude', label: 'L' }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      controller.createStatic({ provider: 'claude', label: 'L', envKey: 'HOME', value: 'x' }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(controller.importOpencode({ providerIds: [] })).rejects.toBeInstanceOf(ZodError);
    await expect(controller.delete('not-a-uuid')).rejects.toBeInstanceOf(ZodError);
    await expect(
      controller.checkout('11111111-1111-4111-8111-111111111111', { remoteId: 'nope' }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      controller.release('11111111-1111-4111-8111-111111111111', { extra: true }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(vault.createStatic).not.toHaveBeenCalled();
    expect(vault.delete).not.toHaveBeenCalled();
  });
});
