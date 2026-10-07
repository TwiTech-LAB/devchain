import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ProviderEffortsController } from './provider-efforts.controller';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { ProviderAdapterFactory } from '../adapters';

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
  });

  describe('POST /api/providers/:id/efforts', () => {
    it.each([
      {
        name: 'single',
        input: { name: 'high' },
        response: {
          id: 'e1',
          providerId: 'provider-1',
          name: 'high',
          position: 0,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        expectedArgs: [
          {
            providerId: 'provider-1',
            name: 'high',
          },
        ],
      },
      {
        name: 'bulk',
        input: {
          efforts: [
            { name: 'high', position: 2 },
            { name: 'low', position: 1 },
            { name: 'medium' },
          ],
        },
        response: {
          added: ['low', 'high'],
          existing: ['medium'],
        },
        expectedArgs: ['provider-1', ['low', 'high', 'medium']],
      },
    ])(
      'creates efforts through the $name branch',
      async ({ name, input, response, expectedArgs }) => {
        const create =
          name === 'single' ? storage.createProviderEffort : storage.bulkCreateProviderEfforts;
        create.mockResolvedValue(response);
        const result = await controller.createProviderEffort('provider-1', input);
        expect(create.mock.calls[0]).toEqual(expectedArgs);
        if (name === 'single') expect(result).toMatchObject({ name: 'high' });
        else expect(result).toEqual({ ...response, total: 3 });
      },
    );
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
