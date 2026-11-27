// Unit tests with real temporary files are the cheapest layer that detects symlink and atomic-write failures.
import { Test } from '@nestjs/testing';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { ConflictError, ValidationError } from '../../../common/errors/error-types';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { TranscriptPathValidator } from '../../session-reader/services/transcript-path-validator.service';
import {
  createReplicaDb,
  replicaSeeder,
  seedReplicaSource,
  T,
} from '../replica/__fixtures__/replica-seed';
import { TranscriptFilesService } from './transcript-files.service';
import type { TranscriptFile } from './transcript-transfer.dto';

const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const file: TranscriptFile = { provider: 'claude', path: `-project/${uuid}.jsonl` };

describe('TranscriptFilesService', () => {
  let root: string;
  let service: TranscriptFilesService;
  let validator: TranscriptPathValidator;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'transcript-files-'));
    validator = new TranscriptPathValidator({
      claude: [join(root, 'claude')],
      codex: [join(root, 'codex')],
      devin: [join(root, 'devin')],
    });
    const module = await Test.createTestingModule({
      providers: [
        TranscriptFilesService,
        { provide: DB_CONNECTION, useValue: {} },
        {
          provide: TranscriptPathValidator,
          useValue: validator,
        },
      ],
    }).compile();
    service = module.get(TranscriptFilesService);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // Claude names a saved tool output in three native record shapes.
  const claudeOutputRecords = {
    'structured Bash result': (path: string) => ({
      type: 'user',
      toolUseResult: { persistedOutputPath: path },
    }),
    'persisted-output notice': (path: string) => ({
      type: 'user',
      toolUseResult: [{ type: 'text', text: 'preview' }],
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: [
              {
                type: 'text',
                text: `<persisted-output>\nOutput too large (1.3MB). Full output saved to: ${path}\n\nPreview (first 2KB):\nline\n</persisted-output>`,
              },
            ],
          },
        ],
      },
    }),
    'oversized MCP result notice': (path: string) => ({
      type: 'user',
      toolUseResult: 'Error: result exceeds maximum allowed tokens.',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: `Error: result (69,978 characters across 1,720 lines) exceeds maximum allowed tokens. Output has been saved to ${path}.\nFormat: Plain text\nUse offset and limit parameters to read specific portions of the file.`,
          },
        ],
      },
    }),
  };

  it.each([
    ...Object.entries(claudeOutputRecords).map(([shape, claudeOutput]) => ({
      name: `claude (${shape})`,
      provider: 'claude' as const,
      claudeOutput,
    })),
    {
      name: 'codex',
      provider: 'codex' as const,
      claudeOutput: claudeOutputRecords['structured Bash result'],
    },
  ])(
    'carries $name save-point and child dependencies after the source rows are deleted',
    async ({ provider, claudeOutput }) => {
      const { db, sqlite } = createReplicaDb();
      try {
        seedReplicaSource(sqlite);
        const workspace = '/project';
        const otherWorkspace = '/project-other';
        sqlite.prepare("UPDATE projects SET root_path = ? WHERE id = 'A'").run(workspace);
        sqlite.prepare("UPDATE projects SET root_path = ? WHERE id = 'B'").run(otherWorkspace);
        const files = new TranscriptFilesService(validator, db);
        const sourceId = uuid;
        const saveId = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
        const childId = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee';
        const missingId = 'dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee';
        const foreignId = 'eeeeeeee-bbbb-cccc-dddd-eeeeeeeeeeee';
        const transcript = (id: string): TranscriptFile => ({
          provider,
          path:
            provider === 'codex'
              ? `2026/09/26/rollout-2026-09-26T12-00-00-${id}.jsonl`
              : `-project/${id}.jsonl`,
        });
        const source = transcript(sourceId);
        const save = transcript(saveId);
        const child = transcript(childId);
        const tool: TranscriptFile = {
          provider: 'claude',
          path: `-project/${sourceId}/tool-results/output.txt`,
        };
        const codexMeta = (id: string, base?: string, cwd = workspace) => ({
          type: 'session_meta',
          payload: { id, cwd, history_base: base ? { thread_id: base } : undefined },
        });
        const put = async (file: TranscriptFile, ...records: unknown[]) => {
          const body = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
          await files.write(file, Readable.from(body), Buffer.byteLength(body));
        };
        const insertSession = (id: string, parent: string | null, kind = 'session') => {
          replicaSeeder(sqlite).insert('sessions', {
            id,
            agent_id: 'agent-1',
            kind,
            status: 'stopped',
            parent_session_id: parent,
            provider_session_id: id,
            provider_name_at_launch: provider,
            transcript_path: files.path(transcript(id)),
            started_at: T,
            ended_at: T,
            created_at: T,
            updated_at: T,
          });
        };
        insertSession(sourceId, null);
        insertSession(saveId, sourceId, 'save_point');
        insertSession(childId, saveId);
        if (provider === 'claude') {
          await put(tool, 'retained tool result');
          await put(
            { provider, path: `-project/${sourceId}/tool-results/unreferenced.txt` },
            'unreferenced tool result',
          );
          await put(source, claudeOutput(files.path(tool)));
          await put(save, claudeOutput(files.path(tool)));
          await put(child, claudeOutput(files.path(tool)));
        } else {
          await put(source, codexMeta(sourceId));
          await put(save, codexMeta(saveId, sourceId));
          await put(child, codexMeta(childId, saveId));
        }

        const remove = sqlite.prepare('DELETE FROM sessions WHERE id = ?');
        remove.run(sourceId);
        const dependency = provider === 'claude' ? tool : source;
        const inventory = await files.projectRefs('A');
        expect(inventory.refs).toContainEqual(dependency);
        expect(inventory.skipped).toBe(0);
        expect(inventory.listing.files.map(({ file }) => file)).toEqual(
          expect.arrayContaining([save, child, dependency]),
        );
        expect(inventory.listing.files).toHaveLength(3);
        expect(await files.list(inventory.refs)).toEqual(inventory.listing);

        remove.run(saveId);
        if (provider === 'claude') {
          const outside = join(root, 'outside', tool.path);
          await mkdir(dirname(outside), { recursive: true });
          await writeFile(outside, 'outside provider root');
          const foreign: TranscriptFile = {
            provider,
            path: `-project-other/${foreignId}/tool-results/output.txt`,
          };
          await put(foreign, 'other workspace tool result');
          await put(
            child,
            claudeOutput(files.path(tool)),
            claudeOutput(join(dirname(files.path(tool)), 'missing.txt')),
            claudeOutput(outside),
            claudeOutput(files.path(foreign)),
            // Ordinary tool output with the same words names no companion file.
            {
              type: 'user',
              toolUseResult: { stdout: 'Report complete. Output has been saved to results.csv.' },
              message: {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'tool-2',
                    content: 'Report complete. Output has been saved to results.csv.',
                  },
                ],
              },
            },
          );
        } else {
          await put(source, codexMeta(sourceId, missingId));
        }
        const expected = provider === 'claude' ? [child, tool] : [child, save, source];
        const expectInventory = async (skipped: number) => {
          const childInventory = await files.projectRefs('A');
          const recorded = files.recordedProjectRefs('A');
          const fromHost = await files.list(recorded.refs, 'A');
          expect(childInventory.skipped).toBe(skipped);
          expect(fromHost).toEqual({ ...childInventory.listing, skipped });
          expect(fromHost.files.map(({ file }) => file)).toEqual(expect.arrayContaining(expected));
          expect(fromHost.files).toHaveLength(expected.length);
          expect(fromHost.missing).toBe(0);
        };
        await expectInventory(provider === 'claude' ? 3 : 1);
        if (provider === 'codex') {
          await put(transcript(foreignId), codexMeta(foreignId, undefined, otherWorkspace));
          await put(source, codexMeta(sourceId, foreignId));
          await expectInventory(1);
        }
      } finally {
        sqlite.close();
      }
    },
  );

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

  // A saved row and real files exercise the handoff inventory and its content hashes.
  it('lists a Devin save point export and store session files with content hashes', async () => {
    const { db, sqlite } = createReplicaDb();
    try {
      seedReplicaSource(sqlite);
      const inventory = new TranscriptFilesService(validator, db);
      const nativeId = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      const sessionsDir = 'stores/A/cli/sessions';
      const session = `${sessionsDir}/${nativeId}`;
      const exportFile: TranscriptFile = { provider: 'devin', path: `${uuid}.json` };
      const log: TranscriptFile = { provider: 'devin', path: `${session}/log.jsonl` };
      const meta: TranscriptFile = { provider: 'devin', path: `${session}/meta.json` };
      replicaSeeder(sqlite).insert('sessions', {
        id: uuid,
        agent_id: 'agent-1',
        kind: 'save_point',
        status: 'stopped',
        provider_session_id: nativeId,
        provider_name_at_launch: 'devin',
        transcript_path: inventory.path(exportFile),
        started_at: T,
        ended_at: T,
        created_at: T,
        updated_at: T,
      });
      const files = [exportFile, log, meta];
      for (const entry of files) await inventory.write(entry, Readable.from('data'), 4);
      const linked = join(root, 'devin', sessionsDir, 'linked');
      await mkdir(linked);
      await symlink(inventory.path(log), join(linked, 'log.jsonl'));

      const { refs, skipped } = inventory.recordedProjectRefs('A');
      expect(skipped).toBe(0);
      expect(refs).toEqual([exportFile, { provider: 'devin', path: session }]);
      const listing = await inventory.list([
        ...refs,
        { provider: 'devin', path: `${sessionsDir}/linked` },
      ]);
      const sha256 = createHash('sha256').update('data').digest('hex');
      expect(listing.missing).toBe(1);
      expect(listing.files).toEqual(
        expect.arrayContaining(files.map((file) => ({ file, size: 4, sha256 }))),
      );
      expect(listing.files).toHaveLength(3);
    } finally {
      sqlite.close();
    }
  });

  it.each([
    'not-a-uuid.json',
    `../${uuid}.json`,
    `/${uuid}.json`,
    `${uuid}.jsonl`,
    'stores/project-1/cli/prompt_history.jsonl',
    'stores/project-1/cli/session_locks/brave-otter.lock',
    'stores/project-1/cli/sessions/brave-otter/other.json',
    'stores/project-1/cli/sessions/Brave-Otter/log.jsonl',
    'stores/project-1/cli/sessions/../brave-otter/log.jsonl',
    'stores/../cli/sessions/brave-otter/log.jsonl',
    'stores/project-1/cli/sessions/brave-otter/log.jsonl\n',
  ])('refuses invalid Devin path %s', async (path) => {
    await expect(
      service.write({ provider: 'devin', path }, Readable.from('x'), 1),
    ).rejects.toThrow();
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
