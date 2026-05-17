import { resolveAgentNames } from './agent-name-resolver';

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

describe('resolveAgentNames', () => {
  const mockStorage = {
    getAgent: jest.fn(),
  } as unknown as jest.Mocked<{ getAgent: (id: string) => Promise<{ id: string; name: string }> }>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves multiple agent names in a single batch', async () => {
    mockStorage.getAgent
      .mockResolvedValueOnce({ id: 'a1', name: 'Agent One' })
      .mockResolvedValueOnce({ id: 'a2', name: 'Agent Two' })
      .mockResolvedValueOnce({ id: 'a3', name: 'Agent Three' });

    const result = await resolveAgentNames(mockStorage as never, new Set(['a1', 'a2', 'a3']));

    expect(result).toEqual(
      new Map([
        ['a1', 'Agent One'],
        ['a2', 'Agent Two'],
        ['a3', 'Agent Three'],
      ]),
    );
    expect(mockStorage.getAgent).toHaveBeenCalledTimes(3);
  });

  it('returns empty map for empty input set', async () => {
    const result = await resolveAgentNames(mockStorage as never, new Set());
    expect(result).toEqual(new Map());
    expect(mockStorage.getAgent).not.toHaveBeenCalled();
  });

  it('gracefully handles individual agent lookup failures', async () => {
    mockStorage.getAgent
      .mockResolvedValueOnce({ id: 'a1', name: 'Agent One' })
      .mockRejectedValueOnce(new Error('not found'))
      .mockResolvedValueOnce({ id: 'a3', name: 'Agent Three' });

    const result = await resolveAgentNames(mockStorage as never, new Set(['a1', 'a2', 'a3']));

    expect(result).toEqual(
      new Map([
        ['a1', 'Agent One'],
        ['a3', 'Agent Three'],
      ]),
    );
    expect(result.has('a2')).toBe(false);
  });
});
