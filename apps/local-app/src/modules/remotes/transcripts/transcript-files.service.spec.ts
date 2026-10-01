// Unit tests with real temporary files are the cheapest layer that detects symlink and atomic-write failures.
import { Test } from '@nestjs/testing';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { ConflictError, ValidationError } from '../../../common/errors/error-types';
import { execFileSync } from 'node:child_process';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { TranscriptPathValidator } from '../../session-reader/services/transcript-path-validator.service';
import { TranscriptFilesService } from './transcript-files.service';
import type { TranscriptFile } from './transcript-transfer.dto';

const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const file: TranscriptFile = { provider: 'claude', path: `-project/${uuid}.jsonl` };

describe('TranscriptFilesService', () => {
  let root: string;
  let service: TranscriptFilesService;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'transcript-files-'));
    const module = await Test.createTestingModule({
      providers: [
        TranscriptFilesService,
        { provide: DB_CONNECTION, useValue: {} },
        {
          provide: TranscriptPathValidator,
          useValue: new TranscriptPathValidator({
            claude: [join(root, 'claude')],
            codex: [join(root, 'codex')],
          }),
        },
      ],
    }).compile();
    service = module.get(TranscriptFilesService);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lists only recorded regular files, subagents and tool results and counts missing sessions', async () => {
    const files: TranscriptFile[] = [
      file,
      { provider: 'claude', path: `-project/${uuid}/subagents/agent-a1.jsonl` },
      { provider: 'claude', path: `-project/${uuid}/tool-results/output.txt` },
      { provider: 'codex', path: '2026/09/26/rollout-123.jsonl' },
    ];
    for (const entry of files) await service.write(entry, Readable.from('data'), 4);
    const folder = join(root, 'claude', '-project', uuid, 'subagents');
    await writeFile(join(folder, '.agent-hidden.part'), 'hidden');
    await symlink(service.path(file), join(folder, 'agent-link.jsonl'));
    execFileSync('mkfifo', [join(folder, 'agent-pipe.jsonl')]);
    const listing = await service.list([
      { provider: 'claude', path: `-project/${uuid}` },
      { provider: 'codex', path: files[3].path },
      { provider: 'codex', path: '2026/09/26/rollout-missing.jsonl' },
    ]);
    expect(listing.missing).toBe(1);
    expect(listing.files).toHaveLength(4);
    expect(listing.files).toEqual(expect.arrayContaining(files.map((file) => ({ file, size: 4 }))));
  });

  it('rejects a concurrent destination write with a domain conflict and releases it after completion', async () => {
    const body = new PassThrough();
    const first = service.write(file, body, 3);
    try {
      await expect(service.write(file, Readable.from('new'), 3)).rejects.toThrow(ConflictError);
    } finally {
      body.end('old');
      await first;
    }
    await service.write(file, Readable.from('new'), 3);
    expect(await readFile(service.path(file), 'utf8')).toBe('new');
  });

  it.each(['short', 'overflow', 'interrupted', 'cancelled'])(
    'keeps the previous destination on %s and a retry replaces it',
    async (failure) => {
      await service.write(file, Readable.from('old'), 3);
      const abort = new AbortController();
      const body =
        failure === 'interrupted'
          ? Readable.from(
              (async function* () {
                yield 'ab';
                throw new Error('lost connection');
              })(),
            )
          : Readable.from('new');
      if (failure === 'cancelled') abort.abort();
      await expect(
        service.write(
          file,
          body,
          failure === 'short' ? 4 : failure === 'overflow' ? 2 : 3,
          abort.signal,
        ),
      ).rejects.toThrow();
      expect(await readFile(service.path(file), 'utf8')).toBe('old');
      expect(await readdir(dirname(service.path(file)))).toEqual([`${uuid}.jsonl`]);
      await service.write(file, Readable.from('new complete'), 12);
      expect(await readFile(service.path(file), 'utf8')).toBe('new complete');
    },
  );

  it.each([
    '../outside.jsonl',
    '-project/not-a-uuid.jsonl',
    `-project/${uuid}/../other.jsonl`,
    `-project/${uuid}/subagents/no-agent.jsonl`,
    `-project/${uuid}/tool-results/../secret`,
    `-project/${uuid}/tool-results/.hidden`,
    '/absolute.jsonl',
    `-project/${uuid}.jsonl\n`,
  ])('refuses invalid path %s', async (path) => {
    await expect(
      service.write({ provider: 'claude', path }, Readable.from('x'), 1),
    ).rejects.toThrow();
  });

  it('refuses symlink ancestors, symlink files, directories and oversized writes', async () => {
    await mkdir(join(root, 'outside'));
    await mkdir(join(root, 'claude'));
    await symlink(join(root, 'outside'), join(root, 'claude', '-project'));
    await expect(service.write(file, Readable.from('x'), 1)).rejects.toThrow(ValidationError);
    await rm(join(root, 'claude', '-project'));
    await mkdir(dirname(service.path(file)));
    await writeFile(join(root, 'outside', 'target'), 'secret');
    await symlink(join(root, 'outside', 'target'), service.path(file));
    await expect(service.read(file)).rejects.toThrow(ValidationError);
    await expect(service.write(file, Readable.from('x'), 1)).rejects.toThrow(ValidationError);
    await rm(service.path(file));
    await mkdir(service.path(file));
    await expect(service.write(file, Readable.from('x'), 1)).rejects.toThrow(ValidationError);
    await expect(service.write(file, Readable.from('x'), 1024 ** 3 + 1)).rejects.toThrow(
      ValidationError,
    );
    expect(await readFile(join(root, 'outside', 'target'), 'utf8')).toBe('secret');
  });
});
