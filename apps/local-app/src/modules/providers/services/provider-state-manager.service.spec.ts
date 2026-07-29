/**
 * Layer: module-unit
 * Why: ProviderStateManager coordinates provider mutation, auto-compact config, and binary validation.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { Stats, constants } from 'fs';
import * as fsPromises from 'fs/promises';
import { ProviderStateManager } from './provider-state-manager.service';
import { ProviderProjectSyncService } from './provider-project-sync.service';
import { ProviderEffortSeedingService } from './provider-effort-seeding.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { ValidationError } from '../../../common/errors/error-types';
import type { Provider } from '../../storage/models/domain.models';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import {
  disableClaudeAutoCompact,
  enableClaudeAutoCompact,
} from '../../sessions/utils/claude-config';
import { DEFAULT_CLAUDE_LAUNCH_SETTINGS_JSON } from '@devchain/shared';

jest.mock('fs/promises', () => ({
  stat: jest.fn(),
  access: jest.fn(),
}));

jest.mock('../../sessions/utils/claude-config', () => ({
  disableClaudeAutoCompact: jest.fn(),
  enableClaudeAutoCompact: jest.fn(),
}));

const mockDisableClaudeAutoCompact = disableClaudeAutoCompact as jest.MockedFunction<
  typeof disableClaudeAutoCompact
>;
const mockEnableClaudeAutoCompact = enableClaudeAutoCompact as jest.MockedFunction<
  typeof enableClaudeAutoCompact
>;

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'provider-1',
    name: 'claude',
    binPath: '/usr/local/bin/claude',
    mcpConfigured: false,
    mcpEndpoint: null,
    mcpRegisteredAt: null,
    autoCompactThreshold: null,
    claudeLaunchSettingsJson: DEFAULT_CLAUDE_LAUNCH_SETTINGS_JSON,
    env: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('ProviderStateManager', () => {
  let service: ProviderStateManager;
  let mockStorage: Record<string, jest.Mock>;
  let mockExecutor: jest.Mocked<Pick<ProcessExecutor, 'run'>>;
  let mockSyncService: { syncProviderToAllProjects: jest.Mock };
  let mockEffortSeeding: { seedForProvider: jest.Mock; backfillAll: jest.Mock };

  beforeEach(async () => {
    mockStorage = {
      getProvider: jest.fn(),
      updateProvider: jest
        .fn()
        .mockImplementation((_id, payload) => Promise.resolve({ ...makeProvider(), ...payload })),
      updateProviderWithScopes: jest
        .fn()
        .mockImplementation((_id, payload) => Promise.resolve({ ...makeProvider(), ...payload })),
      createProvider: jest
        .fn()
        .mockImplementation((payload) => Promise.resolve({ id: 'provider-1', ...payload })),
      deleteProvider: jest.fn().mockResolvedValue(undefined),
      listAllProfileProviderConfigs: jest.fn().mockResolvedValue([]),
      listAgentProfiles: jest.fn().mockResolvedValue({ items: [] }),
    };
    mockExecutor = { run: jest.fn() };
    mockSyncService = {
      syncProviderToAllProjects: jest.fn().mockResolvedValue({
        providerId: 'provider-1',
        insertedCount: 0,
        affectedProjectIds: [],
        skippedExistingCount: 0,
        skippedConflictCount: 0,
        warnings: [],
        excludedAuthorCount: 0,
        scopeConfigHash: 'test',
      }),
    };
    mockEffortSeeding = {
      seedForProvider: jest.fn().mockResolvedValue({ added: [], existing: [] }),
      backfillAll: jest.fn().mockResolvedValue({ providers: 0, seededProviders: 0 }),
    };
    mockDisableClaudeAutoCompact.mockReset();
    mockEnableClaudeAutoCompact.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProviderStateManager,
        { provide: STORAGE_SERVICE, useValue: mockStorage },
        { provide: ProviderProjectSyncService, useValue: mockSyncService },
        { provide: ProcessExecutor, useValue: mockExecutor },
        { provide: ProviderEffortSeedingService, useValue: mockEffortSeeding },
      ],
    }).compile();

    service = module.get(ProviderStateManager);
  });

  it('creates, seeds, and syncs a provider', async () => {
    const result = await service.create({
      name: 'Claude',
      binPath: null,
      autoCompactThreshold: 95,
      env: null,
    });

    expect(mockStorage.createProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'claude',
        binPath: null,
        autoCompactThreshold: 95,
      }),
    );
    expect(mockEffortSeeding.seedForProvider).toHaveBeenCalled();
    expect(mockSyncService.syncProviderToAllProjects).toHaveBeenCalledWith('provider-1');
    expect(result.provider).toBeDefined();
  });

  it('does not fail creation when effort seeding throws', async () => {
    mockEffortSeeding.seedForProvider.mockRejectedValueOnce(new Error('seed boom'));

    await expect(service.create({ name: 'claude', binPath: null, env: null })).resolves.toEqual(
      expect.objectContaining({ provider: expect.any(Object) }),
    );
  });

  it('degrades gracefully when post-create sync throws', async () => {
    mockSyncService.syncProviderToAllProjects.mockRejectedValue(new Error('sync fail'));

    await expect(service.create({ name: 'claude', binPath: null, env: null })).resolves.toEqual(
      expect.objectContaining({ sync: null, syncError: 'sync fail' }),
    );
  });

  it('passes launch settings through without collapsing omission into null', async () => {
    await service.create({ name: 'claude', binPath: null, env: null });
    expect(mockStorage.createProvider).toHaveBeenLastCalledWith(
      expect.objectContaining({ claudeLaunchSettingsJson: undefined }),
    );

    await service.create({
      name: 'claude',
      binPath: null,
      claudeLaunchSettingsJson: null,
      env: null,
    });
    expect(mockStorage.createProvider).toHaveBeenLastCalledWith(
      expect.objectContaining({ claudeLaunchSettingsJson: null }),
    );
  });

  it('updates only surviving provider state', async () => {
    mockStorage.getProvider.mockResolvedValue(makeProvider());

    await service.update('provider-1', {
      name: 'CLAUDE',
      autoCompactThreshold: 88,
      env: { FOO: 'bar' },
    });

    expect(mockStorage.updateProviderWithScopes).toHaveBeenCalledWith(
      'provider-1',
      { name: 'claude', autoCompactThreshold: 88, env: { FOO: 'bar' } },
      undefined,
      ['FOO'],
    );
  });

  it('preserves omitted launch settings and forwards explicit clear', async () => {
    mockStorage.getProvider.mockResolvedValue(makeProvider());

    await service.update('provider-1', { binPath: '/new/claude' });
    expect(mockStorage.updateProviderWithScopes.mock.calls[0][1]).not.toHaveProperty(
      'claudeLaunchSettingsJson',
    );

    await service.update('provider-1', { claudeLaunchSettingsJson: null });
    expect(mockStorage.updateProviderWithScopes.mock.calls[1][1]).toMatchObject({
      claudeLaunchSettingsJson: null,
    });
  });

  it('deletes an unreferenced provider', async () => {
    await service.deleteProvider('provider-1');
    expect(mockStorage.deleteProvider).toHaveBeenCalledWith('provider-1');
  });

  it('rejects deletion while profile configs reference the provider', async () => {
    mockStorage.listAllProfileProviderConfigs.mockResolvedValue([
      { id: 'config-1', providerId: 'provider-1', profileId: 'profile-1' },
    ]);
    mockStorage.listAgentProfiles.mockResolvedValue({
      items: [{ id: 'profile-1', name: 'Default' }],
    });

    await expect(service.deleteProvider('provider-1')).rejects.toThrow(ValidationError);
  });

  it('enables and disables Claude auto-compact config', async () => {
    mockStorage.getProvider.mockResolvedValue(makeProvider());
    mockEnableClaudeAutoCompact.mockResolvedValue({ success: true });
    mockDisableClaudeAutoCompact.mockResolvedValue({ success: true });

    await expect(service.enableAutoCompact('provider-1')).resolves.toEqual({ success: true });
    await expect(service.disableAutoCompact('provider-1')).resolves.toEqual({ success: true });
  });

  it('rejects auto-compact config for non-Claude providers', async () => {
    mockStorage.getProvider.mockResolvedValue(makeProvider({ name: 'codex' }));

    await expect(service.enableAutoCompact('provider-1')).rejects.toThrow(ValidationError);
    await expect(service.disableAutoCompact('provider-1')).rejects.toThrow(ValidationError);
  });

  describe('normalizeBinPath', () => {
    const mockStat = fsPromises.stat as jest.MockedFunction<typeof fsPromises.stat>;
    const mockAccess = fsPromises.access as jest.MockedFunction<typeof fsPromises.access>;

    beforeEach(() => {
      mockStat.mockReset();
      mockAccess.mockReset();
    });

    it.each([null, undefined, '', '   '])('returns null for %p', async (value) => {
      await expect(service.normalizeBinPath(value)).resolves.toBeNull();
    });

    it('preserves and validates an absolute executable file path', async () => {
      mockStat.mockResolvedValue({ isFile: () => true } as Stats);
      mockAccess.mockResolvedValue(undefined);

      await expect(service.normalizeBinPath('/usr/local/bin/claude')).resolves.toBe(
        '/usr/local/bin/claude',
      );
      expect(mockAccess).toHaveBeenCalledWith('/usr/local/bin/claude', constants.X_OK);
    });

    it('rejects a missing absolute path', async () => {
      mockStat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));

      await expect(service.normalizeBinPath('/missing/claude')).rejects.toThrow(
        'Provider binary path does not exist.',
      );
    });

    it('keeps a command name when it is found on PATH', async () => {
      mockExecutor.run.mockResolvedValue({
        success: true,
        exitCode: 0,
        stdout: '/usr/local/bin/claude\n',
        stderr: '',
        timedOut: false,
      });

      await expect(service.normalizeBinPath('claude')).resolves.toBe('claude');
    });

    it('rejects a command name missing from PATH', async () => {
      mockExecutor.run.mockResolvedValue({
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: '',
        timedOut: false,
      });

      await expect(service.normalizeBinPath('missing')).rejects.toThrow(ValidationError);
    });
  });
});
