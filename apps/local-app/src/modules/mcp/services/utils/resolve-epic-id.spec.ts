import { resolveEpicId } from './resolve-epic-id';
import type { StorageService } from '../../../storage/interfaces/storage.interface';

describe('resolveEpicId', () => {
  const projectId = 'project-1';
  let storage: jest.Mocked<Pick<StorageService, 'getEpicsByIdPrefix'>>;

  beforeEach(() => {
    storage = {
      getEpicsByIdPrefix: jest.fn(),
    };
  });

  it('returns epicId directly for a full UUID without calling storage', async () => {
    const fullUuid = '22222222-2222-2222-2222-222222222222';

    const result = await resolveEpicId(storage as unknown as StorageService, projectId, fullUuid);

    expect(result.success).toBe(true);
    expect((result.data as { epicId: string }).epicId).toBe(fullUuid);
    expect(storage.getEpicsByIdPrefix).not.toHaveBeenCalled();
  });

  it('treats a non-UUID 36-char string as a prefix and calls storage', async () => {
    const notUuid = 'abcdefgh-ijkl-mnop-qrst-uvwxyz123456';
    storage.getEpicsByIdPrefix.mockResolvedValue([
      { id: 'abcdefgh-real-uuid-1234-567890abcdef', title: 'Matched Epic' },
    ]);

    const result = await resolveEpicId(storage as unknown as StorageService, projectId, notUuid);

    expect(result.success).toBe(true);
    expect(storage.getEpicsByIdPrefix).toHaveBeenCalledWith(projectId, notUuid);
  });

  it('resolves a single prefix match to the matched epicId', async () => {
    const prefix = 'abcd1234';
    const matchedId = 'abcd1234-5678-9abc-def0-123456789abc';
    storage.getEpicsByIdPrefix.mockResolvedValue([{ id: matchedId, title: 'My Epic' }]);

    const result = await resolveEpicId(storage as unknown as StorageService, projectId, prefix);

    expect(result.success).toBe(true);
    expect((result.data as { epicId: string }).epicId).toBe(matchedId);
  });

  it('returns EPIC_NOT_FOUND when no epics match the prefix', async () => {
    const prefix = 'deadbeef';
    storage.getEpicsByIdPrefix.mockResolvedValue([]);

    const result = await resolveEpicId(storage as unknown as StorageService, projectId, prefix);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EPIC_NOT_FOUND');
    expect(result.error?.message).toContain('deadbeef');
  });

  it('returns AMBIGUOUS_EPIC when multiple epics match the prefix', async () => {
    const prefix = 'aabbccdd';
    storage.getEpicsByIdPrefix.mockResolvedValue([
      { id: 'aabbccdd-1111-1111-1111-111111111111', title: 'Epic A' },
      { id: 'aabbccdd-2222-2222-2222-222222222222', title: 'Epic B' },
    ]);

    const result = await resolveEpicId(storage as unknown as StorageService, projectId, prefix);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('AMBIGUOUS_EPIC');
    expect(result.error?.message).toContain('aabbccdd');
    expect(result.error?.message).toContain('Epic A');
    expect(result.error?.message).toContain('Epic B');
    const data = result.error?.data as {
      matchingEpics: Array<{ id: string; title: string }>;
      totalMatches: number;
    };
    expect(data.matchingEpics).toHaveLength(2);
    expect(data.totalMatches).toBe(2);
  });

  it('caps the ambiguity data payload at 10 entries with totalMatches count', async () => {
    const prefix = '11111111';
    const matches = Array.from({ length: 15 }, (_, i) => ({
      id: `11111111-${String(i).padStart(4, '0')}-0000-0000-000000000000`,
      title: `Epic ${i}`,
    }));
    storage.getEpicsByIdPrefix.mockResolvedValue(matches);

    const result = await resolveEpicId(storage as unknown as StorageService, projectId, prefix);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('AMBIGUOUS_EPIC');
    // Message should mention "and 5 more"
    expect(result.error?.message).toContain('5 more');
    // Data payload capped at 10 with totalMatches showing actual count
    const data = result.error?.data as {
      matchingEpics: Array<{ id: string; title: string }>;
      totalMatches: number;
    };
    expect(data.matchingEpics).toHaveLength(10);
    expect(data.totalMatches).toBe(15);
  });
});
