import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HostDockerService } from './host-docker.service';
import { DockerArchiveJournal } from '../../core/controllers/docker-archive-journal';

jest.mock('node:fs/promises', () => ({
  ...jest.requireActual('node:fs/promises'),
  realpath: jest.fn(),
  lstat: jest.fn(),
  stat: jest.fn(),
  statfs: jest.fn(),
}));
const home = homedir();
const nested = join(home, 'nested');
const service = new HostDockerService({} as DockerArchiveJournal);

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(fs.realpath).mockImplementation(async (path) => String(path));
  jest.mocked(fs.lstat).mockResolvedValue({} as never);
  jest
    .mocked(fs.stat)
    .mockImplementation(async (path) => ({ dev: path === nested ? 2n : 1n }) as never);
  jest
    .mocked(fs.statfs)
    .mockImplementation(
      async (path) => ({ bavail: path === nested ? 20 : 10, bsize: 4096 }) as never,
    );
});
it('samples a nested filesystem independently of the home filesystem', async () => {
  expect(await service.capacity([home, nested])).toEqual({
    paths: [
      { path: home, filesystemId: '1', freeBytes: 40960 },
      { path: nested, filesystemId: '2', freeBytes: 81920 },
    ],
  });
});
it('uses the nearest existing ancestor for a missing destination', async () => {
  const path = join(nested, 'not-yet', 'created');
  jest.mocked(fs.lstat).mockImplementation(async (value) => {
    if (value !== nested) throw Object.assign(new Error(), { code: 'ENOENT' });
    return {} as never;
  });
  expect(await service.capacity([path])).toEqual({
    paths: [{ path, filesystemId: '2', freeBytes: 81920 }],
  });
  expect(fs.statfs).toHaveBeenCalledWith(nested);
});
it.each(['/outside', 'relative', home + '/../escape', home + '//extra'])(
  'refuses outside-home or non-normalized input %s',
  async (path) => {
    await expect(service.capacity([path])).rejects.toMatchObject({ statusCode: 403 });
    expect(fs.statfs).not.toHaveBeenCalled();
  },
);
it('reports inaccessible paths as unknown without returning error details', async () => {
  jest
    .mocked(fs.lstat)
    .mockRejectedValue(Object.assign(new Error('private detail'), { code: 'EACCES' }));
  expect(await service.capacity([nested])).toEqual({ paths: [{ path: nested, unknown: true }] });
});
it('reports symlink escape and dangling symlinks as unknown', async () => {
  jest
    .mocked(fs.realpath)
    .mockImplementation(async (path) => (path === nested ? '/outside' : String(path)));
  expect(await service.capacity([nested])).toEqual({ paths: [{ path: nested, unknown: true }] });
  jest.mocked(fs.realpath).mockImplementation(async (path) => {
    if (path === nested) throw Object.assign(new Error(), { code: 'ENOENT' });
    return String(path);
  });
  expect(await service.capacity([nested])).toEqual({ paths: [{ path: nested, unknown: true }] });
  expect(fs.statfs).not.toHaveBeenCalled();
});
