import { ProviderStorageDelegate } from './provider.delegate';
import type { StorageDelegateContext } from './base-storage.delegate';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

function createDelegate() {
  const mockDb = {
    select: jest.fn(),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
    update: jest.fn(),
    delete: jest.fn(),
  } as unknown as BetterSQLite3Database;

  const context: StorageDelegateContext = {
    db: mockDb,
    rawClient: null as never,
  };

  const delegate = new ProviderStorageDelegate(context, {
    updateProvider: jest.fn(),
  });

  return { delegate };
}

describe('ProviderStorageDelegate.createProvider — CLAUDE_CODE_NO_FLICKER default', () => {
  it('adds CLAUDE_CODE_NO_FLICKER=1 when Claude provider has no env', async () => {
    const { delegate } = createDelegate();
    const result = await delegate.createProvider({ name: 'claude' });
    expect(result.env).toEqual({ CLAUDE_CODE_NO_FLICKER: '1' });
  });

  it('merges CLAUDE_CODE_NO_FLICKER=1 when Claude provider has other env keys', async () => {
    const { delegate } = createDelegate();
    const result = await delegate.createProvider({ name: 'claude', env: { OTHER_KEY: 'x' } });
    expect(result.env).toEqual({ OTHER_KEY: 'x', CLAUDE_CODE_NO_FLICKER: '1' });
  });

  it('preserves caller value when CLAUDE_CODE_NO_FLICKER is explicitly set', async () => {
    const { delegate } = createDelegate();
    const result = await delegate.createProvider({
      name: 'claude',
      env: { CLAUDE_CODE_NO_FLICKER: '0' },
    });
    expect(result.env).toEqual({ CLAUDE_CODE_NO_FLICKER: '0' });
  });

  it('does not add CLAUDE_CODE_NO_FLICKER for non-Claude providers', async () => {
    const { delegate } = createDelegate();
    const result = await delegate.createProvider({ name: 'codex' });
    expect(result.env).toBeNull();
  });
});
