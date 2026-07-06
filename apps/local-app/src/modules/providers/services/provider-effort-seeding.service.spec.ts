import { ProviderEffortSeedingService } from './provider-effort-seeding.service';
import { ClaudeAdapter } from '../adapters/claude.adapter';
import { CodexAdapter } from '../adapters/codex.adapter';
import { CopilotAdapter } from '../adapters/copilot.adapter';
import { OpencodeAdapter } from '../adapters/opencode.adapter';
import type { ProviderAdapterFactory } from '../adapters';
import type { StorageService } from '../../storage/interfaces/storage.interface';

/**
 * Layer: pure-unit. The seeding logic is exercised against the REAL adapter
 * instances (so the seeded values ARE the single-source-of-truth
 * `defaultEffortValues`, not a duplicated literal) with a mocked factory +
 * storage — the cheapest layer that proves the mapping and the capability gate.
 * `bulkCreateProviderEfforts` idempotency itself is proven in the delegate specs.
 */
describe('ProviderEffortSeedingService', () => {
  // Real adapters expose their actual defaultEffortValues; agy is a bare object
  // WITHOUT applyEffort → not effort-capable.
  const adapters: Record<string, unknown> = {
    claude: new ClaudeAdapter(),
    codex: new CodexAdapter(),
    copilot: new CopilotAdapter(undefined as never, undefined as never),
    opencode: new OpencodeAdapter(),
    agy: { providerName: 'agy' },
  };

  let bulkCreateProviderEfforts: jest.Mock;
  let listProviders: jest.Mock;
  let service: ProviderEffortSeedingService;

  beforeEach(() => {
    bulkCreateProviderEfforts = jest
      .fn()
      .mockImplementation((_id: string, names: string[]) =>
        Promise.resolve({ added: names, existing: [] }),
      );
    listProviders = jest.fn();

    const factory = {
      isSupported: (name: string) => name in adapters,
      getAdapter: (name: string) => adapters[name],
    } as unknown as ProviderAdapterFactory;
    const storage = { bulkCreateProviderEfforts, listProviders } as unknown as StorageService;

    service = new ProviderEffortSeedingService(factory, storage);
  });

  describe('seedForProvider — defaults sourced from adapter metadata', () => {
    it.each([
      ['claude', ['low', 'medium', 'high', 'xhigh', 'max']],
      ['codex', ['minimal', 'low', 'medium', 'high', 'xhigh']],
      ['copilot', ['low', 'medium', 'high', 'xhigh', 'max']],
      ['opencode', ['minimal', 'low', 'medium', 'high']],
    ])('seeds %s with its adapter default effort values', async (name, expected) => {
      await service.seedForProvider({ id: `${name}-1`, name });
      expect(bulkCreateProviderEfforts).toHaveBeenCalledWith(`${name}-1`, expected);
    });

    it('seeds nothing for agy (not effort-capable)', async () => {
      const result = await service.seedForProvider({ id: 'agy-1', name: 'agy' });
      expect(bulkCreateProviderEfforts).not.toHaveBeenCalled();
      expect(result).toEqual({ added: [], existing: [] });
    });

    it('seeds nothing for an unsupported provider name', async () => {
      const result = await service.seedForProvider({ id: 'x-1', name: 'unknown-provider' });
      expect(bulkCreateProviderEfforts).not.toHaveBeenCalled();
      expect(result).toEqual({ added: [], existing: [] });
    });

    it('is additive-only: passes the delegate result through (idempotent skip-existing)', async () => {
      bulkCreateProviderEfforts.mockResolvedValueOnce({ added: [], existing: ['low', 'medium'] });
      const result = await service.seedForProvider({ id: 'claude-1', name: 'claude' });
      expect(result).toEqual({ added: [], existing: ['low', 'medium'] });
    });
  });

  describe('backfillAll', () => {
    it('seeds every listed provider through the shared path and counts seeded ones', async () => {
      listProviders.mockResolvedValue({
        items: [
          { id: 'c-1', name: 'claude' },
          { id: 'a-1', name: 'agy' }, // not capable → 0 added
          { id: 'o-1', name: 'opencode' },
        ],
      });

      const result = await service.backfillAll();

      expect(bulkCreateProviderEfforts).toHaveBeenCalledWith('c-1', [
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ]);
      expect(bulkCreateProviderEfforts).toHaveBeenCalledWith('o-1', [
        'minimal',
        'low',
        'medium',
        'high',
      ]);
      expect(result).toEqual({ providers: 3, seededProviders: 2 });
    });

    it('isolates a per-provider failure and continues with the rest', async () => {
      listProviders.mockResolvedValue({
        items: [
          { id: 'c-1', name: 'claude' },
          { id: 'o-1', name: 'opencode' },
        ],
      });
      bulkCreateProviderEfforts.mockRejectedValueOnce(new Error('db boom')); // claude fails first

      const result = await service.backfillAll();

      expect(bulkCreateProviderEfforts).toHaveBeenCalledWith('o-1', [
        'minimal',
        'low',
        'medium',
        'high',
      ]);
      expect(result).toEqual({ providers: 2, seededProviders: 1 });
    });
  });
});
