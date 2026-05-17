import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { Provider } from '../../storage/models/domain.models';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { SeederContext } from '../types/seeder.types';
import { runSeedRemoveClaudeNoFlickerEnv } from './0008_seed_remove_claude_no_flicker_env';

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'provider-claude',
    name: 'Claude',
    binPath: null,
    mcpConfigured: false,
    mcpEndpoint: null,
    mcpRegisteredAt: null,
    env: null,
    autoCompactThreshold: null,
    autoCompactThreshold1m: null,
    oneMillionContextEnabled: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createContext(providers: Provider[]): {
  ctx: SeederContext;
  updateProvider: jest.Mock;
} {
  const updateProvider = jest.fn().mockResolvedValue(undefined);
  const storage = {
    listProviders: jest.fn().mockResolvedValue({ items: providers, total: providers.length }),
    updateProvider,
  } as unknown as StorageService;

  const ctx: SeederContext = {
    storage,
    watchersService: {} as SeederContext['watchersService'],
    db: {} as BetterSQLite3Database,
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
    } as unknown as SeederContext['logger'],
  };

  return { ctx, updateProvider };
}

describe('0008_seed_remove_claude_no_flicker_env', () => {
  it('no-ops when no Claude provider is present', async () => {
    const { ctx, updateProvider } = createContext([
      makeProvider({ id: 'provider-openai', name: 'OpenAI' }),
    ]);
    await runSeedRemoveClaudeNoFlickerEnv(ctx);
    expect(updateProvider).not.toHaveBeenCalled();
  });

  it('no-ops when Claude env is null', async () => {
    const { ctx, updateProvider } = createContext([makeProvider({ env: null })]);
    await runSeedRemoveClaudeNoFlickerEnv(ctx);
    expect(updateProvider).not.toHaveBeenCalled();
  });

  it('removes CLAUDE_CODE_NO_FLICKER while preserving existing env keys', async () => {
    const { ctx, updateProvider } = createContext([
      makeProvider({ env: { OTHER_KEY: 'x', CLAUDE_CODE_NO_FLICKER: '1' } }),
    ]);
    await runSeedRemoveClaudeNoFlickerEnv(ctx);
    expect(updateProvider).toHaveBeenCalledTimes(1);
    expect(updateProvider).toHaveBeenCalledWith('provider-claude', {
      env: { OTHER_KEY: 'x' },
    });
  });

  it('clears env to null when CLAUDE_CODE_NO_FLICKER was the only key', async () => {
    const { ctx, updateProvider } = createContext([
      makeProvider({ env: { CLAUDE_CODE_NO_FLICKER: '1' } }),
    ]);
    await runSeedRemoveClaudeNoFlickerEnv(ctx);
    expect(updateProvider).toHaveBeenCalledTimes(1);
    expect(updateProvider).toHaveBeenCalledWith('provider-claude', {
      env: null,
    });
  });
});
