import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { Provider } from '../../storage/models/domain.models';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { SeederContext } from '../services/data-seeder.service';
import { runSeedClaudeNoFlickerEnv } from './0007_seed_claude_no_flicker_env';

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

describe('0007_seed_claude_no_flicker_env', () => {
  it('no-ops when no Claude provider is present', async () => {
    const { ctx, updateProvider } = createContext([
      makeProvider({ id: 'provider-openai', name: 'OpenAI' }),
    ]);
    await runSeedClaudeNoFlickerEnv(ctx);
    expect(updateProvider).not.toHaveBeenCalled();
  });

  it('sets CLAUDE_CODE_NO_FLICKER when env is null', async () => {
    const { ctx, updateProvider } = createContext([makeProvider({ env: null })]);
    await runSeedClaudeNoFlickerEnv(ctx);
    expect(updateProvider).toHaveBeenCalledTimes(1);
    expect(updateProvider).toHaveBeenCalledWith('provider-claude', {
      env: { CLAUDE_CODE_NO_FLICKER: '1' },
    });
  });

  it('merges CLAUDE_CODE_NO_FLICKER while preserving existing env keys', async () => {
    const { ctx, updateProvider } = createContext([makeProvider({ env: { OTHER_KEY: 'x' } })]);
    await runSeedClaudeNoFlickerEnv(ctx);
    expect(updateProvider).toHaveBeenCalledTimes(1);
    expect(updateProvider).toHaveBeenCalledWith('provider-claude', {
      env: { OTHER_KEY: 'x', CLAUDE_CODE_NO_FLICKER: '1' },
    });
  });

  it('no-ops when CLAUDE_CODE_NO_FLICKER is already set (any value)', async () => {
    const { ctx, updateProvider } = createContext([
      makeProvider({ env: { CLAUDE_CODE_NO_FLICKER: '0' } }),
    ]);
    await runSeedClaudeNoFlickerEnv(ctx);
    expect(updateProvider).not.toHaveBeenCalled();
  });
});
