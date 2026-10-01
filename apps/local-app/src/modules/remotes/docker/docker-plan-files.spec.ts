// Permission failures must preserve known bytes so an incomplete walk cannot understate certainty.
import * as fs from 'node:fs/promises';
import { projectAnchoredPath, measureDockerBind } from './docker-plan-files';

jest.mock('node:fs/promises', () => ({ lstat: jest.fn(), opendir: jest.fn() }));
afterEach(() => jest.resetAllMocks());
it('retains readable bytes when another child returns EACCES', async () => {
  jest.mocked(fs.lstat).mockImplementation(async (path) => {
    if (String(path).endsWith('/private')) throw Object.assign(new Error(), { code: 'EACCES' });
    return {
      isSymbolicLink: () => false,
      isFile: () => String(path).endsWith('/file'),
      isDirectory: () => String(path) === '/data',
      size: 123,
    } as Awaited<ReturnType<typeof fs.lstat>>;
  });
  jest.mocked(fs.opendir).mockResolvedValue({
    async *[Symbol.asyncIterator]() {
      yield { name: 'file' };
      yield { name: 'private' };
    },
    close: async () => undefined,
  } as Awaited<ReturnType<typeof fs.opendir>>);
  expect(await measureDockerBind('/data')).toEqual({ bytes: 123, unknown: true });
});

it('anchors data subtrees to the project and refuses the project root itself', () => {
  expect(projectAnchoredPath('/home/u/proj', '/home/u/proj/data/pg')).toBe('/data/pg');
  expect(projectAnchoredPath('/home/u/proj/', '/home/u/proj/data')).toBe('/data');
  expect(() => projectAnchoredPath('/home/u/proj', '/home/u/proj')).toThrow();
  expect(() => projectAnchoredPath('/home/u/proj/', '/home/u/proj')).toThrow();
});

it('stops the walk when the caller aborts mid-measure', async () => {
  jest.mocked(fs.lstat).mockResolvedValue({
    isSymbolicLink: () => false,
    isFile: () => false,
    isDirectory: () => true,
  } as Awaited<ReturnType<typeof fs.lstat>>);
  jest.mocked(fs.opendir).mockResolvedValue({
    async *[Symbol.asyncIterator]() {
      yield { name: 'file' };
      yield { name: 'other' };
    },
    close: async () => undefined,
  } as Awaited<ReturnType<typeof fs.opendir>>);
  const controller = new AbortController();
  const measure = measureDockerBind('/data', Date.now() + 60_000, controller.signal);
  controller.abort();
  await expect(measure).rejects.toThrow();
});
