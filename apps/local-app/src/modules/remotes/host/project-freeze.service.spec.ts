/**
 * ProjectFreezeService unit tests.
 * Test layer: pure unit. The service's contract is the in-memory mirror of a
 * persisted flag; a fake storage port is the cheapest reliable way to prove
 * restore-on-start, persistence order and the 423 error.
 */
import { ProjectFrozenError } from '../../../common/errors/error-types';
import type { ProjectHostStorage } from '../../storage/interfaces/storage.interface';
import { ProjectFreezeService } from './project-freeze.service';

function createStorage(frozen: Array<{ projectId: string; frozenAt: string }> = []) {
  return {
    listFrozenProjects: jest.fn().mockResolvedValue(frozen),
    setProjectFrozen: jest.fn().mockResolvedValue(undefined),
    releaseProject: jest.fn(),
    findEpicIdByIdempotencyKey: jest.fn(),
  } satisfies Record<keyof ProjectHostStorage, jest.Mock>;
}

describe('ProjectFreezeService', () => {
  it('restores persisted freezes on start', async () => {
    const service = new ProjectFreezeService(
      createStorage([{ projectId: 'p1', frozenAt: '2026-09-22T10:00:00.000Z' }]),
    );

    await service.onModuleInit();

    expect(service.isFrozen('p1')).toBe(true);
    expect(() => service.assertWritable('p1')).toThrow(ProjectFrozenError);
    expect(() => service.assertWritable('p2')).not.toThrow();
  });

  it('keeps the first frozenAt when frozen twice and clears it on thaw', async () => {
    const storage = createStorage();
    const service = new ProjectFreezeService(storage);

    const first = await service.freeze('p1');
    const second = await service.freeze('p1');
    await service.thaw('p1');

    expect(second.frozenAt).toBe(first.frozenAt);
    expect(storage.setProjectFrozen.mock.calls).toEqual([
      ['p1', first.frozenAt],
      ['p1', first.frozenAt],
      ['p1', null],
    ]);
    expect(service.isFrozen('p1')).toBe(false);
  });

  it('does not mark a project frozen when persisting fails', async () => {
    const storage = createStorage();
    storage.setProjectFrozen.mockRejectedValue(new Error('not found'));
    const service = new ProjectFreezeService(storage);

    await expect(service.freeze('missing')).rejects.toThrow('not found');

    expect(service.isFrozen('missing')).toBe(false);
  });

  it('holds a freeze in memory only and keeps an existing frozenAt', async () => {
    const storage = createStorage();
    const service = new ProjectFreezeService(storage);

    const held = service.hold('p1', '2026-09-22T10:00:00.000Z');
    const again = service.hold('p1', '2026-09-22T11:00:00.000Z');

    expect(held).toBe('2026-09-22T10:00:00.000Z');
    expect(again).toBe(held);
    expect(() => service.assertWritable('p1')).toThrow(ProjectFrozenError);
    expect(storage.setProjectFrozen).not.toHaveBeenCalled();
    expect((await service.freeze('p1')).frozenAt).toBe(held);
  });

  it('forgets a held freeze without touching storage', () => {
    const storage = createStorage();
    const service = new ProjectFreezeService(storage);
    service.hold('p1', '2026-09-22T10:00:00.000Z');

    service.forget('p1');

    expect(service.isFrozen('p1')).toBe(false);
    expect(() => service.assertWritable('p1')).not.toThrow();
    expect(storage.setProjectFrozen).not.toHaveBeenCalled();
  });

  it('reports 423 PROJECT_FROZEN', async () => {
    const service = new ProjectFreezeService(createStorage());
    await service.freeze('p1');

    expect(() => service.assertWritable('p1')).toThrow(
      expect.objectContaining({ statusCode: 423, code: 'PROJECT_FROZEN' }),
    );
  });
});
