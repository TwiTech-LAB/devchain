import type { RecordToolContext } from './record-context';
import {
  handleAddTags,
  handleCreateRecord,
  handleGetRecord,
  handleListRecords,
  handleRemoveTags,
  handleUpdateRecord,
} from './record-tools';

const RECORD = {
  id: 'record-1',
  epicId: 'epic-1',
  type: 'decision',
  data: { accepted: true },
  tags: ['one', 'two'],
  version: 2,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

function createContext(): RecordToolContext {
  return {
    storage: {
      createRecord: jest.fn().mockResolvedValue(RECORD),
      updateRecord: jest.fn().mockResolvedValue({ ...RECORD, version: 3 }),
      getRecord: jest.fn().mockResolvedValue(RECORD),
      listRecords: jest.fn().mockResolvedValue({ items: [RECORD], total: 1, limit: 50, offset: 0 }),
      deleteRecord: jest.fn().mockResolvedValue(undefined),
    },
  };
}

describe('record-tools handlers', () => {
  it('creates a record with an empty default tag list', async () => {
    const ctx = createContext();

    await handleCreateRecord(ctx, { epicId: 'epic-1', type: 'decision', data: {} });

    expect(ctx.storage.createRecord).toHaveBeenCalledWith({
      epicId: 'epic-1',
      type: 'decision',
      data: {},
      tags: [],
    });
  });

  it('updates a record with optimistic version separated from the patch', async () => {
    const ctx = createContext();

    await handleUpdateRecord(ctx, { id: 'record-1', data: { accepted: false }, version: 2 });

    expect(ctx.storage.updateRecord).toHaveBeenCalledWith(
      'record-1',
      { data: { accepted: false }, type: undefined, tags: undefined },
      2,
    );
  });

  it('maps a complete record detail', async () => {
    const ctx = createContext();

    await expect(handleGetRecord(ctx, { id: 'record-1' })).resolves.toMatchObject({
      success: true,
      data: { id: 'record-1', type: 'decision', tags: ['one', 'two'], version: 2 },
    });
  });

  it('filters listed records by type and every requested tag', async () => {
    const ctx = createContext();
    (ctx.storage.listRecords as jest.Mock).mockResolvedValue({
      items: [
        RECORD,
        { ...RECORD, id: 'record-2', type: 'note' },
        { ...RECORD, id: 'record-3', tags: ['one'] },
      ],
    });

    await expect(
      handleListRecords(ctx, {
        epicId: 'epic-1',
        type: 'decision',
        tags: ['one', 'two'],
        limit: 50,
        offset: 0,
      }),
    ).resolves.toMatchObject({ success: true, data: { total: 1, records: [{ id: 'record-1' }] } });
  });

  it('adds only distinct tags using the stored version', async () => {
    const ctx = createContext();

    await handleAddTags(ctx, { id: 'record-1', tags: ['two', 'three'] });

    expect(ctx.storage.updateRecord).toHaveBeenCalledWith(
      'record-1',
      { tags: ['one', 'two', 'three'] },
      2,
    );
  });

  it('removes requested tags using the stored version', async () => {
    const ctx = createContext();

    await handleRemoveTags(ctx, { id: 'record-1', tags: ['one'] });

    expect(ctx.storage.updateRecord).toHaveBeenCalledWith('record-1', { tags: ['two'] }, 2);
  });
});
