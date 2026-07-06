import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ProviderEffortsController } from './provider-efforts.controller';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { ProviderAdapterFactory } from '../adapters';
import { ConflictError } from '../../../common/errors/error-types';

// Test layer: module-unit. The efforts controller is a thin read-CRUD boundary
// over STORAGE_SERVICE + adapter-factory capability probing; mocking both at this
// layer is the cheapest proof of the endpoint contract (capability signal,
// position ordering, CI dedupe, scoping). Storage-side dedupe/position is covered
// by the delegate integration specs (Task 1), not duplicated here.
describe('ProviderEffortsController', () => {
  let controller: ProviderEffortsController;
  let storage: {
    getProvider: jest.Mock;
    listProviderEffortsByProvider: jest.Mock;
    createProviderEffort: jest.Mock;
    bulkCreateProviderEfforts: jest.Mock;
    deleteProviderEffort: jest.Mock;
  };
  let adapterFactory: {
    isSupported: jest.Mock;
    getAdapter: jest.Mock;
  };

  // Provider fixtures. capability is derived from the adapter via isEffortCapable
  // at this endpoint only — provider rows themselves carry no effort metadata.
  const claudeProvider = {
    id: 'provider-1',
    name: 'claude',
    binPath: '/usr/local/bin/claude',
    mcpConfigured: false,
    mcpEndpoint: null,
    mcpRegisteredAt: null,
    autoCompactThreshold: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };

  const agyProvider = { ...claudeProvider, id: 'provider-agy', name: 'agy' };
  const opencodeProvider = { ...claudeProvider, id: 'provider-opencode', name: 'opencode' };
  const unknownProvider = { ...claudeProvider, id: 'provider-unknown', name: 'acme-cli' };

  // A flag-based adapter (effort-capable adapters expose `applyEffort`).
  const makeAdapter = (opts: {
    effortCapable?: boolean;
    requiresModelForEffort?: boolean;
  }): Record<string, unknown> => {
    const adapter: Record<string, unknown> = { name: 'fake' };
    if (opts.effortCapable) {
      adapter.applyEffort = () => ({ argv: [], env: {} });
      adapter.defaultEffortValues = ['low', 'medium', 'high'];
      if (opts.requiresModelForEffort) {
        adapter.requiresModelForEffort = true;
      }
    }
    return adapter;
  };

  const adapters: Record<string, Record<string, unknown>> = {
    claude: makeAdapter({ effortCapable: true }),
    agy: makeAdapter({ effortCapable: false }),
    // OpenCode's effort mechanism is per-model (keyed on effectiveModel), so it
    // requires a model selection before effort can be placed.
    opencode: makeAdapter({ effortCapable: true, requiresModelForEffort: true }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    storage = {
      getProvider: jest.fn().mockResolvedValue(claudeProvider),
      listProviderEffortsByProvider: jest.fn().mockResolvedValue([]),
      createProviderEffort: jest.fn(),
      bulkCreateProviderEfforts: jest.fn(),
      deleteProviderEffort: jest.fn().mockResolvedValue(undefined),
    };

    adapterFactory = {
      isSupported: jest.fn((name: string) => name.toLowerCase() in adapters),
      getAdapter: jest.fn((name: string) => adapters[name.toLowerCase()]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProviderEffortsController],
      providers: [
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: ProviderAdapterFactory, useValue: adapterFactory },
      ],
    }).compile();

    controller = module.get(ProviderEffortsController);
  });

  describe('GET /api/providers/:id/efforts', () => {
    it('returns supportsEffort=true + requiresModelForEffort=false for a capable provider with an EMPTY catalog (empty ≠ unsupported)', async () => {
      storage.listProviderEffortsByProvider.mockResolvedValue([]);

      const result = await controller.listProviderEfforts('provider-1');

      expect(storage.getProvider).toHaveBeenCalledWith('provider-1');
      expect(adapterFactory.isSupported).toHaveBeenCalledWith('claude');
      expect(adapterFactory.getAdapter).toHaveBeenCalledWith('claude');
      expect(result).toEqual({ efforts: [], supportsEffort: true, requiresModelForEffort: false });
    });

    it('returns seeded efforts for a capable provider', async () => {
      storage.listProviderEffortsByProvider.mockResolvedValue([
        { id: 'e1', providerId: 'provider-1', name: 'high', position: 0 },
        { id: 'e2', providerId: 'provider-1', name: 'max', position: 1 },
      ]);

      const result = await controller.listProviderEfforts('provider-1');

      expect(result.efforts).toHaveLength(2);
      expect(result.supportsEffort).toBe(true);
      expect(result.requiresModelForEffort).toBe(false);
    });

    it('returns supportsEffort=false for agy (supported adapter, not effort-capable)', async () => {
      storage.getProvider.mockResolvedValue(agyProvider);

      const result = await controller.listProviderEfforts('provider-agy');

      expect(adapterFactory.isSupported).toHaveBeenCalledWith('agy');
      expect(adapterFactory.getAdapter).toHaveBeenCalledWith('agy');
      expect(result).toEqual({ efforts: [], supportsEffort: false, requiresModelForEffort: false });
    });

    it('returns requiresModelForEffort=true for an effort-capable, per-model adapter (opencode shape)', async () => {
      storage.getProvider.mockResolvedValue(opencodeProvider);

      const result = await controller.listProviderEfforts('provider-opencode');

      expect(result.supportsEffort).toBe(true);
      expect(result.requiresModelForEffort).toBe(true);
    });

    it('returns supportsEffort=false for a provider unknown to the adapter factory (no getAdapter call)', async () => {
      storage.getProvider.mockResolvedValue(unknownProvider);
      adapterFactory.isSupported.mockReturnValue(false);

      const result = await controller.listProviderEfforts('provider-unknown');

      expect(adapterFactory.isSupported).toHaveBeenCalledWith('acme-cli');
      expect(adapterFactory.getAdapter).not.toHaveBeenCalled();
      expect(result).toEqual({ efforts: [], supportsEffort: false, requiresModelForEffort: false });
    });

    it('propagates NotFoundException when provider does not exist', async () => {
      storage.getProvider.mockRejectedValue(new NotFoundException('Provider not found'));

      await expect(controller.listProviderEfforts('missing')).rejects.toThrow(NotFoundException);
      expect(storage.listProviderEffortsByProvider).not.toHaveBeenCalled();
      expect(adapterFactory.isSupported).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/providers/:id/efforts', () => {
    it('creates a single effort from {name}', async () => {
      storage.createProviderEffort.mockResolvedValue({
        id: 'e1',
        providerId: 'provider-1',
        name: 'high',
        position: 0,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      const result = await controller.createProviderEffort('provider-1', { name: 'high' });

      expect(storage.createProviderEffort).toHaveBeenCalledWith({
        providerId: 'provider-1',
        name: 'high',
      });
      expect(result.name).toBe('high');
    });

    it('bulk imports efforts from {efforts} with position ordering and returns stats', async () => {
      storage.bulkCreateProviderEfforts.mockResolvedValue({
        added: ['low', 'high'],
        existing: ['medium'],
      });

      const result = await controller.createProviderEffort('provider-1', {
        efforts: [{ name: 'high', position: 2 }, { name: 'low', position: 1 }, { name: 'medium' }],
      });

      // Ordered by explicit position (low@1, high@2), ties/missing fall back to
      // input order (medium last via MAX_SAFE_INTEGER).
      expect(storage.bulkCreateProviderEfforts).toHaveBeenCalledWith('provider-1', [
        'low',
        'high',
        'medium',
      ]);
      expect(result).toEqual({ added: ['low', 'high'], existing: ['medium'], total: 3 });
    });

    it('reports CI-deduped (already-existing) efforts via the delegate result', async () => {
      storage.bulkCreateProviderEfforts.mockResolvedValue({ added: [], existing: ['high'] });

      const result = await controller.createProviderEffort('provider-1', {
        efforts: [{ name: 'high' }],
      });

      expect(result).toEqual({ added: [], existing: ['high'], total: 1 });
    });

    it('rejects invalid payload {}', async () => {
      await expect(controller.createProviderEffort('provider-1', {})).rejects.toThrow();
      expect(storage.createProviderEffort).not.toHaveBeenCalled();
      expect(storage.bulkCreateProviderEfforts).not.toHaveBeenCalled();
    });

    it('rejects invalid payload {name: ""}', async () => {
      await expect(controller.createProviderEffort('provider-1', { name: '' })).rejects.toThrow();
      expect(storage.createProviderEffort).not.toHaveBeenCalled();
    });

    it('rejects invalid payload {efforts: "invalid"}', async () => {
      await expect(
        controller.createProviderEffort('provider-1', { efforts: 'invalid' }),
      ).rejects.toThrow();
      expect(storage.bulkCreateProviderEfforts).not.toHaveBeenCalled();
    });

    it('propagates ConflictError for duplicate single-effort create', async () => {
      storage.createProviderEffort.mockRejectedValue(
        new ConflictError('Effort "high" already exists for this provider.'),
      );

      await expect(controller.createProviderEffort('provider-1', { name: 'high' })).rejects.toThrow(
        ConflictError,
      );
    });
  });

  describe('DELETE /api/providers/:id/efforts/:effortId', () => {
    it('deletes an effort scoped to the provider', async () => {
      storage.listProviderEffortsByProvider.mockResolvedValue([
        { id: 'e1', providerId: 'provider-1', name: 'high', position: 0 },
      ]);

      const result = await controller.deleteProviderEffort('provider-1', 'e1');

      expect(storage.deleteProviderEffort).toHaveBeenCalledWith('e1');
      expect(result).toEqual({ success: true });
    });

    it('throws NotFoundException when effort is not found under provider', async () => {
      storage.listProviderEffortsByProvider.mockResolvedValue([
        { id: 'e2', providerId: 'provider-1', name: 'high', position: 0 },
      ]);

      await expect(controller.deleteProviderEffort('provider-1', 'e1')).rejects.toThrow(
        NotFoundException,
      );
      expect(storage.deleteProviderEffort).not.toHaveBeenCalled();
    });
  });
});
