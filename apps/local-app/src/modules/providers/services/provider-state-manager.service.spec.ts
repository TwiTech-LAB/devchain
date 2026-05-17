/**
 * Layer: module-unit
 * Why: ProviderStateManager contains pure state-machine logic (1M enable/disable, threshold defaulting,
 * probe-proof gating). Mocked storage + real ProbeProofService on :memory: SQLite are sufficient —
 * the bug class being caught is incorrect state transitions, not storage query correctness.
 */
import { Test, TestingModule } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { ProviderStateManager } from './provider-state-manager.service';
import { ProbeProofService } from './probe-proof.service';
import { ProviderProjectSyncService } from './provider-project-sync.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { ValidationError } from '../../../common/errors/error-types';
import type { Provider } from '../../storage/models/domain.models';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { Stats, constants } from 'fs';
import * as fsPromises from 'fs/promises';
import {
  disableClaudeAutoCompact,
  enableClaudeAutoCompact,
} from '../../sessions/utils/claude-config';

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

function buildProofDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE provider_probe_proofs (
      provider_id TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
      bin_path TEXT NOT NULL,
      recorded_at INTEGER NOT NULL
    );
  `);
  sqlite.prepare("INSERT INTO providers (id, name) VALUES ('provider-1', 'claude')").run();
  return drizzle(sqlite);
}

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'provider-1',
    name: 'claude',
    binPath: '/usr/local/bin/claude',
    mcpConfigured: false,
    mcpEndpoint: null,
    mcpRegisteredAt: null,
    autoCompactThreshold: null,
    autoCompactThreshold1m: null,
    oneMillionContextEnabled: false,
    env: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('ProviderStateManager', () => {
  let service: ProviderStateManager;
  let probeProofService: ProbeProofService;
  let mockStorage: {
    getProvider: jest.Mock;
    updateProvider: jest.Mock;
  };
  let mockExecutor: jest.Mocked<Pick<ProcessExecutor, 'run'>>;
  let mockSyncService: { syncProviderToAllProjects: jest.Mock };

  beforeEach(async () => {
    mockStorage = {
      getProvider: jest.fn(),
      updateProvider: jest
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

    mockDisableClaudeAutoCompact.mockReset();
    mockEnableClaudeAutoCompact.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProviderStateManager,
        ProbeProofService,
        { provide: STORAGE_SERVICE, useValue: mockStorage },
        { provide: ProviderProjectSyncService, useValue: mockSyncService },
        { provide: ProcessExecutor, useValue: mockExecutor },
        { provide: DB_CONNECTION, useValue: buildProofDb() },
      ],
    }).compile();

    service = module.get<ProviderStateManager>(ProviderStateManager);
    probeProofService = module.get<ProbeProofService>(ProbeProofService);
  });

  describe('update — enable-1M with valid proof', () => {
    it('sets oneMillionContextEnabled and defaults thresholds when proof exists', async () => {
      const existing = makeProvider({ binPath: '/usr/local/bin/claude' });
      mockStorage.getProvider.mockResolvedValue(existing);
      probeProofService.recordProof('provider-1', '/usr/local/bin/claude');

      const { provider } = await service.update('provider-1', {
        oneMillionContextEnabled: true,
      });

      expect(mockStorage.updateProvider).toHaveBeenCalledWith(
        'provider-1',
        expect.objectContaining({
          oneMillionContextEnabled: true,
          autoCompactThreshold1m: 50,
          autoCompactThreshold: 95,
        }),
      );
      expect(provider.oneMillionContextEnabled).toBe(true);
    });

    it('does not override autoCompactThreshold when existing value is already set', async () => {
      const existing = makeProvider({ binPath: '/usr/local/bin/claude', autoCompactThreshold: 80 });
      mockStorage.getProvider.mockResolvedValue(existing);
      probeProofService.recordProof('provider-1', '/usr/local/bin/claude');

      await service.update('provider-1', { oneMillionContextEnabled: true });

      const payload = mockStorage.updateProvider.mock.calls[0][1];
      expect(payload.autoCompactThreshold).toBeUndefined();
    });
  });

  describe('update — enable-1M without proof rejected', () => {
    it('throws ValidationError when no proof exists', async () => {
      const existing = makeProvider({ binPath: '/usr/local/bin/claude' });
      mockStorage.getProvider.mockResolvedValue(existing);

      await expect(
        service.update('provider-1', { oneMillionContextEnabled: true }),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when binPath is null', async () => {
      const existing = makeProvider({ binPath: null });
      mockStorage.getProvider.mockResolvedValue(existing);

      await expect(
        service.update('provider-1', { oneMillionContextEnabled: true }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('update — disable-1M restores threshold to 95', () => {
    it('clears 1m threshold and resets standard threshold to 95', async () => {
      const existing = makeProvider({
        oneMillionContextEnabled: true,
        autoCompactThreshold: 70,
        autoCompactThreshold1m: 50,
      });
      mockStorage.getProvider.mockResolvedValue(existing);

      await service.update('provider-1', { oneMillionContextEnabled: false });

      expect(mockStorage.updateProvider).toHaveBeenCalledWith(
        'provider-1',
        expect.objectContaining({
          oneMillionContextEnabled: false,
          autoCompactThreshold1m: null,
          autoCompactThreshold: 95,
        }),
      );
    });

    it('respects explicit autoCompactThreshold when disabling 1M', async () => {
      const existing = makeProvider({ oneMillionContextEnabled: true, autoCompactThreshold1m: 50 });
      mockStorage.getProvider.mockResolvedValue(existing);

      await service.update('provider-1', {
        oneMillionContextEnabled: false,
        autoCompactThreshold: 80,
      });

      const payload = mockStorage.updateProvider.mock.calls[0][1];
      expect(payload.autoCompactThreshold).toBe(80);
    });
  });

  describe('update — binPath-change auto-disable', () => {
    it('auto-disables 1M and clears proof when binPath changes without valid proof', async () => {
      const existing = makeProvider({
        name: 'claude',
        binPath: '/old/claude',
        oneMillionContextEnabled: true,
        autoCompactThreshold1m: 50,
      });
      mockStorage.getProvider.mockResolvedValue(existing);
      probeProofService.recordProof('provider-1', '/old/claude');

      await service.update('provider-1', { binPath: '/new/claude' });

      expect(mockStorage.updateProvider).toHaveBeenCalledWith(
        'provider-1',
        expect.objectContaining({
          binPath: '/new/claude',
          oneMillionContextEnabled: false,
          autoCompactThreshold: 95,
          autoCompactThreshold1m: null,
        }),
      );
      expect(probeProofService.hasValidProof('provider-1', '/old/claude')).toBe(false);
    });

    it('does NOT auto-disable 1M when new binPath has valid proof', async () => {
      const existing = makeProvider({
        name: 'claude',
        binPath: '/old/claude',
        oneMillionContextEnabled: true,
      });
      mockStorage.getProvider.mockResolvedValue(existing);
      probeProofService.recordProof('provider-1', '/new/claude');

      await service.update('provider-1', { binPath: '/new/claude' });

      const payload = mockStorage.updateProvider.mock.calls[0][1];
      expect(payload.oneMillionContextEnabled).toBeUndefined();
    });

    it('does NOT auto-disable 1M for non-claude providers', async () => {
      const existing = makeProvider({
        name: 'codex',
        binPath: '/old/codex',
        oneMillionContextEnabled: true,
      });
      mockStorage.getProvider.mockResolvedValue(existing);

      await service.update('provider-1', { binPath: '/new/codex' });

      const payload = mockStorage.updateProvider.mock.calls[0][1];
      expect(payload.oneMillionContextEnabled).toBeUndefined();
    });
  });

  describe('enableOneMillion', () => {
    it('enables 1M with proof and sets default thresholds', async () => {
      const existing = makeProvider({ binPath: '/usr/local/bin/claude' });
      mockStorage.getProvider.mockResolvedValue(existing);
      probeProofService.recordProof('provider-1', '/usr/local/bin/claude');

      await service.enableOneMillion('provider-1');

      expect(mockStorage.updateProvider).toHaveBeenCalledWith(
        'provider-1',
        expect.objectContaining({
          oneMillionContextEnabled: true,
          autoCompactThreshold1m: 50,
          autoCompactThreshold: 95,
        }),
      );
    });

    it('throws ValidationError when no proof exists', async () => {
      mockStorage.getProvider.mockResolvedValue(makeProvider());

      await expect(service.enableOneMillion('provider-1')).rejects.toThrow(ValidationError);
    });
  });

  describe('disableOneMillion', () => {
    it('disables 1M and restores standard threshold to 95', async () => {
      mockStorage.getProvider.mockResolvedValue(
        makeProvider({ oneMillionContextEnabled: true, autoCompactThreshold1m: 50 }),
      );

      await service.disableOneMillion('provider-1');

      expect(mockStorage.updateProvider).toHaveBeenCalledWith(
        'provider-1',
        expect.objectContaining({
          oneMillionContextEnabled: false,
          autoCompactThreshold1m: null,
          autoCompactThreshold: 95,
        }),
      );
    });
  });

  describe('probe1m', () => {
    it('throws ValidationError for non-claude providers', async () => {
      mockStorage.getProvider.mockResolvedValue(makeProvider({ name: 'codex' }));

      await expect(service.probe1m('provider-1')).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when binPath is null', async () => {
      mockStorage.getProvider.mockResolvedValue(makeProvider({ binPath: null }));

      await expect(service.probe1m('provider-1')).rejects.toThrow(ValidationError);
    });

    it('records proof on successful probe', async () => {
      const provider = makeProvider({ binPath: '/usr/local/bin/claude' });
      mockStorage.getProvider.mockResolvedValue(provider);
      mockExecutor.run.mockResolvedValue({
        stdout: JSON.stringify({
          is_error: false,
          modelUsage: { m: { contextWindow: 1_000_000 } },
        }),
        stderr: '',
        exitCode: 0,
        success: true,
        timedOut: false,
        truncated: false,
      });

      const outcome = await service.probe1m('provider-1');

      expect(outcome.supported).toBe(true);
      expect(probeProofService.hasValidProof('provider-1', '/usr/local/bin/claude')).toBe(true);
    });

    it('does not record proof on failed probe', async () => {
      const provider = makeProvider({ binPath: '/usr/local/bin/claude' });
      mockStorage.getProvider.mockResolvedValue(provider);
      mockExecutor.run.mockResolvedValue({
        stdout: JSON.stringify({ is_error: false, modelUsage: { m: { contextWindow: 200_000 } } }),
        stderr: '',
        exitCode: 0,
        success: true,
        timedOut: false,
        truncated: false,
      });

      const outcome = await service.probe1m('provider-1');

      expect(outcome.supported).toBe(false);
      expect(probeProofService.hasValidProof('provider-1', '/usr/local/bin/claude')).toBe(false);
    });
  });

  describe('create', () => {
    it('creates provider and syncs', async () => {
      const result = await service.create({
        name: 'Claude',
        binPath: null,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        autoCompactThreshold: null,
        env: null,
      });

      expect(mockStorage.createProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'claude',
          binPath: null,
          mcpConfigured: false,
        }),
      );
      expect(mockSyncService.syncProviderToAllProjects).toHaveBeenCalledWith('provider-1');
      expect(result.provider).toBeDefined();
      expect(result.sync).toBeDefined();
    });

    it('throws ValidationError when oneMillionContextEnabled=true', async () => {
      await expect(
        service.create({
          name: 'claude',
          binPath: null,
          env: null,
          oneMillionContextEnabled: true,
        }),
      ).rejects.toThrow(ValidationError);
      expect(mockStorage.createProvider).not.toHaveBeenCalled();
    });

    it('degrades gracefully when sync throws', async () => {
      mockSyncService.syncProviderToAllProjects.mockRejectedValue(new Error('sync fail'));
      const result = await service.create({ name: 'claude', binPath: null, env: null });

      expect(result.sync).toBeNull();
      expect(result.syncError).toBe('sync fail');
    });
  });

  describe('deleteProvider', () => {
    it('deletes provider when no profile configs reference it', async () => {
      await service.deleteProvider('provider-1');
      expect(mockStorage.deleteProvider).toHaveBeenCalledWith('provider-1');
    });

    it('throws ValidationError when provider is referenced by profile configs', async () => {
      mockStorage.listAllProfileProviderConfigs.mockResolvedValue([
        { providerId: 'provider-1', profileId: 'prof-1' },
      ]);
      mockStorage.listAgentProfiles.mockResolvedValue({
        items: [{ id: 'prof-1', name: 'Default' }],
      });

      await expect(service.deleteProvider('provider-1')).rejects.toThrow(ValidationError);
      expect(mockStorage.deleteProvider).not.toHaveBeenCalled();
    });
  });

  describe('disableAutoCompact', () => {
    it('throws ValidationError for non-claude providers', async () => {
      mockStorage.getProvider.mockResolvedValue(makeProvider({ name: 'codex' }));

      await expect(service.disableAutoCompact('provider-1')).rejects.toThrow(ValidationError);
      expect(mockDisableClaudeAutoCompact).not.toHaveBeenCalled();
    });

    it('calls disableClaudeAutoCompact for claude provider', async () => {
      mockStorage.getProvider.mockResolvedValue(makeProvider({ name: 'claude' }));
      mockDisableClaudeAutoCompact.mockResolvedValue({ success: true });

      const result = await service.disableAutoCompact('provider-1');

      expect(mockDisableClaudeAutoCompact).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
    });

    it('returns failure result on config error', async () => {
      mockStorage.getProvider.mockResolvedValue(makeProvider({ name: 'claude' }));
      mockDisableClaudeAutoCompact.mockResolvedValue({
        success: false,
        errorType: 'invalid_config',
      });

      const result = await service.disableAutoCompact('provider-1');
      expect(result.success).toBe(false);
      expect(result.errorType).toBe('invalid_config');
    });
  });

  describe('enableAutoCompact', () => {
    it('throws ValidationError for non-claude providers', async () => {
      mockStorage.getProvider.mockResolvedValue(makeProvider({ name: 'codex' }));

      await expect(service.enableAutoCompact('provider-1')).rejects.toThrow(ValidationError);
      expect(mockEnableClaudeAutoCompact).not.toHaveBeenCalled();
    });

    it('calls enableClaudeAutoCompact for claude provider', async () => {
      mockStorage.getProvider.mockResolvedValue(makeProvider({ name: 'claude' }));
      mockEnableClaudeAutoCompact.mockResolvedValue({ success: true });

      const result = await service.enableAutoCompact('provider-1');

      expect(mockEnableClaudeAutoCompact).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
    });
  });

  describe('normalizeBinPath', () => {
    const statMock = fsPromises.stat as jest.Mock;
    const accessMock = fsPromises.access as jest.Mock;

    beforeEach(() => {
      statMock.mockReset();
      accessMock.mockReset();
    });

    it('returns null for null input', async () => {
      expect(await service.normalizeBinPath(null)).toBeNull();
    });

    it('returns null for undefined input', async () => {
      expect(await service.normalizeBinPath(undefined)).toBeNull();
    });

    it('returns null for empty string', async () => {
      expect(await service.normalizeBinPath('  ')).toBeNull();
    });

    it('preserves absolute path (does not resolve symlinks) and validates it', async () => {
      statMock.mockResolvedValue({ isFile: () => true } as unknown as Stats);
      accessMock.mockResolvedValue(undefined);

      const result = await service.normalizeBinPath('/tmp/some/path/bin');

      expect(statMock).toHaveBeenCalledWith('/tmp/some/path/bin');
      expect(accessMock).toHaveBeenCalledWith('/tmp/some/path/bin', constants.X_OK);
      expect(result).toBe('/tmp/some/path/bin');
    });

    it('throws ValidationError when absolute path does not exist (ENOENT)', async () => {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      statMock.mockRejectedValue(err);

      await expect(service.normalizeBinPath('/nonexistent/bin')).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when path is not a file', async () => {
      statMock.mockResolvedValue({ isFile: () => false } as unknown as Stats);

      await expect(service.normalizeBinPath('/tmp/a-directory')).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when file is not executable (EACCES)', async () => {
      statMock.mockResolvedValue({ isFile: () => true } as unknown as Stats);
      const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
      accessMock.mockRejectedValue(err);

      await expect(service.normalizeBinPath('/tmp/no-exec-bit')).rejects.toThrow(ValidationError);
    });

    it('stores relative command name as-is when found on PATH', async () => {
      mockExecutor.run.mockResolvedValue({
        stdout: '/usr/local/bin/claude\n',
        stderr: '',
        exitCode: 0,
        success: true,
        timedOut: false,
        truncated: false,
      });

      const result = await service.normalizeBinPath('claude');

      expect(result).toBe('claude');
      expect(statMock).not.toHaveBeenCalled();
    });

    it('throws ValidationError when relative command not found on PATH', async () => {
      mockExecutor.run.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 1,
        success: false,
        timedOut: false,
        truncated: false,
      });

      await expect(service.normalizeBinPath('unknown-cmd')).rejects.toThrow(ValidationError);
    });
  });
});
