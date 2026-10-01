jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, opendir: jest.fn(actual.opendir) };
});

import { opendir } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fsPromises from 'node:fs/promises';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { ProjectSizeService } from './project-size.service';

describe('ProjectSizeService', () => {
  let root: string;
  let fileSync: { getIgnores: jest.Mock };
  let service: ProjectSizeService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'devchain-project-size-'));
    fileSync = { getIgnores: jest.fn().mockReturnValue(['(?d)node_modules', '(?d)dist']) };
    service = new ProjectSizeService(fileSync as unknown as FileSyncService);
    jest
      .mocked(opendir)
      .mockImplementation(
        jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises').opendir,
      );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('sums files while excluding ignored directories at every depth', async () => {
    writeFileSync(join(root, 'root.txt'), '12345');
    mkdirSync(join(root, 'src', 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'src', 'kept.txt'), '1234567');
    writeFileSync(join(root, 'src', 'node_modules', 'ignored.txt'), 'ignored');

    await expect(service.measure('project-1', root)).resolves.toEqual({
      bytes: 12,
      approximate: false,
    });
    expect(fileSync.getIgnores).toHaveBeenCalledWith('project-1');
  });

  it('strips Syncthing prefixes and honors case-insensitive name rules', async () => {
    fileSync.getIgnores.mockReturnValue(['(?d)(?i)cache']);
    mkdirSync(join(root, 'nested', 'CACHE'), { recursive: true });
    writeFileSync(join(root, 'nested', 'CACHE', 'ignored.txt'), 'ignored');
    writeFileSync(join(root, 'nested', 'kept.txt'), 'kept');

    await expect(service.measure('project-1', root)).resolves.toEqual({
      bytes: 4,
      approximate: false,
    });
  });

  it('marks unsupported glob rules approximate and still counts their files', async () => {
    fileSync.getIgnores.mockReturnValue(['*.tmp']);
    writeFileSync(join(root, 'kept.tmp'), '1234');

    await expect(service.measure('project-1', root)).resolves.toEqual({
      bytes: 4,
      approximate: true,
    });
  });

  it('skips symlinks rather than following them', async () => {
    const outside = join(root, '..', `devchain-project-size-outside-${Date.now()}`);
    writeFileSync(outside, 'outside');
    symlinkSync(outside, join(root, 'linked.txt'));
    writeFileSync(join(root, 'kept.txt'), 'kept');

    await expect(service.measure('project-1', root)).resolves.toEqual({
      bytes: 4,
      approximate: false,
    });
    rmSync(outside, { force: true });
  });

  it('returns an unknown size when the walk exceeds its deadline', async () => {
    jest
      .mocked(fsPromises.opendir)
      .mockImplementation(() => new Promise<never>(() => undefined) as ReturnType<typeof opendir>);
    await expect(service.measure('project-1', root, 1)).resolves.toEqual({
      bytes: null,
      approximate: true,
    });
  });

  it('returns an unknown size when the root cannot be read', async () => {
    await expect(service.measure('project-1', join(root, 'missing'))).resolves.toEqual({
      bytes: null,
      approximate: true,
    });
  });
});
