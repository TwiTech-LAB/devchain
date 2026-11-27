import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import {
  createAntigravityFixtureDb,
  genMetadataBlob,
} from '../../session-reader/__fixtures__/antigravity-fixture-db';
import { AntigravityMetricsReader } from '../../session-reader/readers/antigravity-metrics.reader';
import { AntigravityAdapter } from './antigravity.adapter';
import { parseProfileOptions } from '../utils/profile-options';
import type { PrepareSessionForkLaunchInput } from './capabilities';
import type { ProviderAdapter } from './provider-adapter.interface';

jest.mock('../../../common/logging/logger', () => {
  // The adapter creates its logger at import time, before a top-level const exists.
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return {
    ...jest.requireActual('../../../common/logging/logger'),
    createLogger: () => logger,
  };
});

const mockLogger = jest
  .requireMock<{ createLogger: () => { warn: jest.Mock } }>('../../../common/logging/logger')
  .createLogger();

describe('AntigravityAdapter', () => {
  let adapter: AntigravityAdapter;

  beforeEach(() => {
    adapter = new AntigravityAdapter({ ensure: jest.fn() } as never);
  });

  describe('static capability surface', () => {
    // agy draws inline by default; a full-screen policy turned off the scroll-up refresh and
    // left stacked reprints in the web terminal's scrollback.
    it('draws inline, without the alternate-screen policy', () => {
      const asProvider: ProviderAdapter = adapter;
      expect(asProvider.terminalOutputBehavior?.usesAlternateScreen ?? false).toBe(false);
    });

    it('seeds the initial prompt via argv (spike (g): agy is argv-only)', () => {
      expect(adapter.initialPromptSeedMode).toBe('argv');
    });

    it('does NOT define launchInitialPromptBehavior (seeding handles the prompt, no paste)', () => {
      const asProvider: ProviderAdapter = adapter;
      expect(asProvider.launchInitialPromptBehavior).toBeUndefined();
    });

    it('declares DB-backed discovery requiring providerSessionId for restore', () => {
      expect(adapter.transcriptDiscoveryStrategy).toBe('all');
      expect(adapter.providerSessionIdRequiredForRestore).toBe(true);
    });
  });

  describe('GlobalMcpConfigCapability (P2-1 — HOME-global mcp_config.json)', () => {
    it('builds a devchain server entry using serverUrl (agy requires serverUrl, not url)', () => {
      const entry = adapter.buildGlobalMcpServerEntry({
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });
      expect(entry).toEqual({
        key: 'devchain',
        value: { serverUrl: 'http://127.0.0.1:3000/mcp' },
      });
    });

    it('defaults the alias to devchain when omitted', () => {
      const entry = adapter.buildGlobalMcpServerEntry({ endpoint: 'http://x/mcp' });
      expect(entry.key).toBe('devchain');
    });

    it('parses mcpServers[].serverUrl into discovered entries', () => {
      const entries = adapter.parseGlobalMcpConfig(
        JSON.stringify({
          mcpServers: {
            devchain: { serverUrl: 'http://127.0.0.1:3000/mcp' },
            legacy: { url: 'http://legacy.test/mcp' },
          },
        }),
      );
      expect(entries).toEqual([
        { alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp', transport: 'HTTP' },
        { alias: 'legacy', endpoint: 'http://legacy.test/mcp', transport: 'HTTP' },
      ]);
    });

    it('returns no entries for an empty/serverless config object', () => {
      expect(adapter.parseGlobalMcpConfig(JSON.stringify({}))).toEqual([]);
      expect(adapter.parseGlobalMcpConfig(JSON.stringify({ mcpServers: {} }))).toEqual([]);
    });
  });

  describe('provisionProjectPath (workspace trust)', () => {
    it('never throws — a service failure becomes a provisioning warning', async () => {
      const ensure = jest.fn().mockRejectedValue(new Error('disk on fire'));
      const withService = new AntigravityAdapter({ ensure } as never);

      const result = await withService.provisionProjectPath('/home/user/project');

      expect(result.success).toBe(true);
      expect(result.warnings).toEqual([
        expect.objectContaining({ message: 'disk on fire', code: 'AGY_TRUST_PROVISION_FAILED' }),
      ]);
    });
  });

  describe('buildLaunchArgs — new mode', () => {
    it('seeds the rendered initial prompt as a --prompt-interactive argv value', () => {
      const { argv } = adapter.buildLaunchArgs({
        mode: 'new',
        profileOptionArgs: ['--model', 'Gemini 3.5 Flash (High)'],
        initialPrompt: 'do the thing',
      });
      expect(argv).toEqual([
        '--prompt-interactive',
        'do the thing',
        '--model',
        'Gemini 3.5 Flash (High)',
      ]);
    });

    it('omits the prompt flag when no initial prompt is configured', () => {
      const { argv } = adapter.buildLaunchArgs({
        mode: 'new',
        profileOptionArgs: ['--model', 'x'],
      });
      expect(argv).toEqual(['--model', 'x']);
      expect(argv).not.toContain('--prompt-interactive');
    });
  });

  describe('buildLaunchArgs — restore mode', () => {
    it('restores the interactive TUI via --conversation <providerSessionId>', () => {
      const { argv } = adapter.buildLaunchArgs({
        mode: 'restore',
        providerSessionId: '146794e4-0429-4e81-8fe2-e7fad9db2342',
        profileOptionArgs: ['--model', 'x'],
      });
      expect(argv).toEqual([
        '--conversation',
        '146794e4-0429-4e81-8fe2-e7fad9db2342',
        '--model',
        'x',
      ]);
    });

    it('does NOT seed an initial prompt on restore', () => {
      const { argv } = adapter.buildLaunchArgs({
        mode: 'restore',
        providerSessionId: 'sess-1',
        profileOptionArgs: [],
        initialPrompt: 'should be ignored',
      });
      expect(argv).toEqual(['--conversation', 'sess-1']);
      expect(argv).not.toContain('should be ignored');
    });
  });

  describe('buildLaunchArgs — forced inline settings', () => {
    const forced = '{"altScreenMode":"never"}';
    const modes = [
      { mode: 'new', prefix: [] },
      { mode: 'new', initialPrompt: 'go', prefix: ['--prompt-interactive', 'go'] },
      { mode: 'restore', providerSessionId: 'conv-1', prefix: ['--conversation', 'conv-1'] },
    ] as const;
    const launch = (
      { mode, ...rest }: (typeof modes)[number],
      profileOptionArgs: string[],
      cliVersion?: string,
    ) =>
      adapter.buildLaunchArgs({
        mode,
        providerSessionId: 'providerSessionId' in rest ? rest.providerSessionId : undefined,
        initialPrompt: 'initialPrompt' in rest ? rest.initialPrompt : undefined,
        profileOptionArgs,
        cliVersion,
      }).argv;

    beforeEach(() => mockLogger.warn.mockClear());

    it.each([undefined, '1.5.17', '0.9.0', 'agy dev build'])(
      'keeps the argv unchanged for version %s',
      (cliVersion) => {
        for (const target of modes) {
          expect(launch(target, ['--model', 'x'], cliVersion)).toEqual([
            ...target.prefix,
            '--model',
            'x',
          ]);
        }
      },
    );

    it.each(['1.5.18', '1.6.0', '2.0.0', 'agy 1.5.18\n'])(
      'forces inline mode on %s',
      (cliVersion) => {
        for (const target of modes) {
          expect(launch(target, ['--model', 'x'], cliVersion)).toEqual([
            ...target.prefix,
            '--settings',
            forced,
            '--model',
            'x',
          ]);
        }
      },
    );

    it.each([
      {
        spelling: '--settings {json} with other keys',
        args: ['--settings', '{"theme":"dark"}', '--model', 'x'],
        expected: ['--settings', '{"theme":"dark","altScreenMode":"never"}', '--model', 'x'],
      },
      {
        spelling: '--settings={json}',
        args: ['--model', 'x', '--settings={"theme":"dark"}'],
        expected: ['--model', 'x', '--settings', '{"theme":"dark","altScreenMode":"never"}'],
      },
      {
        spelling: '-settings {json} that saves "always"',
        args: ['-settings', '{"altScreenMode":"always","theme":"dark"}'],
        expected: ['--settings', '{"altScreenMode":"never","theme":"dark"}'],
      },
      {
        spelling: 'mixed -settings and --settings, where the last one wins',
        args: ['-settings', '{"a":1}', '--model', 'x', '--settings={"b":2}'],
        expected: ['--model', 'x', '--settings', '{"b":2,"altScreenMode":"never"}'],
      },
      {
        spelling: 'a BOM-prefixed object',
        args: ['--settings', '\uFEFF {"theme":"dark"}'],
        expected: ['--settings', '{"theme":"dark","altScreenMode":"never"}'],
      },
      {
        spelling: 'an empty value',
        args: ['--settings', '', '--model', 'x'],
        expected: ['--settings', forced, '--model', 'x'],
      },
      {
        spelling: 'an empty = value',
        args: ['--settings='],
        expected: ['--settings', forced],
      },
      {
        spelling: 'a trailing -- with options after it',
        args: ['--model', 'x', '--', '--settings', '{"a":1}'],
        expected: ['--settings', forced, '--model', 'x', '--', '--settings', '{"a":1}'],
      },
      {
        spelling: 'settings before a trailing --',
        args: ['--settings', '{"a":1}', '--', '-settings', '/tmp/s.json'],
        expected: [
          '--settings',
          '{"a":1,"altScreenMode":"never"}',
          '--',
          '-settings',
          '/tmp/s.json',
        ],
      },
      {
        spelling: 'the = form after a value flag that takes a --settings token',
        args: ['--log-file', '--settings', '--settings={"theme":"dark"}'],
        expected: [
          '--log-file',
          '--settings',
          '--settings',
          '{"theme":"dark","altScreenMode":"never"}',
        ],
      },
      {
        spelling: 'settings after a boolean flag',
        args: ['--sandbox', '-c', '--settings', '{"a":1}'],
        expected: ['--sandbox', '-c', '--settings', '{"a":1,"altScreenMode":"never"}'],
      },
      {
        spelling: 'a profile whose only --settings token is a value flag value',
        args: ['--log-file', '--settings', '--model', 'x'],
        expected: ['--settings', forced, '--log-file', '--settings', '--model', 'x'],
      },
      {
        spelling: 'settings after an argument that ends flag parsing',
        args: ['--model', 'x', 'stray', '--settings', '{"a":1}'],
        expected: ['--settings', forced, '--model', 'x', 'stray', '--settings', '{"a":1}'],
      },
    ])('merges the forced key into $spelling', ({ args, expected }) => {
      for (const target of modes) {
        expect(launch(target, args, '1.5.18')).toEqual([...target.prefix, ...expected]);
      }
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it.each([
      { spelling: 'a file path', args: ['--settings', '/home/u/agy.json', '--model', 'x'] },
      {
        spelling: 'a file path after an object',
        args: ['--settings', '{"a":1}', '-settings=s.json'],
      },
      { spelling: 'invalid JSON', args: ['--settings', '{theme: dark}'] },
      { spelling: 'null', args: ['--settings', 'null'] },
      { spelling: 'an array', args: ['--settings', '[]'] },
      { spelling: 'a bare trailing flag', args: ['--model', 'x', '--settings'] },
      { spelling: 'a flag whose value is --', args: ['--settings', '--', 'tail'] },
    ])('keeps $spelling unchanged and warns', ({ args }) => {
      for (const target of modes) {
        expect(launch(target, args, '1.5.18')).toEqual([...target.prefix, ...args]);
      }
      expect(mockLogger.warn).toHaveBeenCalledTimes(modes.length);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.any(Object),
        'agy --settings is not an inline JSON object; inline mode is not forced',
      );
    });

    // Saved Options are raw text. The shared tokenizer must keep a quoted empty value as one
    // argument; a dropped token turns `--settings ""` into a bare flag, and agy then exits 2 or
    // reads the next option as a file name.
    it.each(['--settings "" --sandbox', "--settings '' --sandbox", '--settings= --sandbox'])(
      'forces inline mode from the saved text %s',
      (raw) => {
        for (const target of modes) {
          expect(launch(target, parseProfileOptions(raw), '1.5.18')).toEqual([
            ...target.prefix,
            '--settings',
            forced,
            '--sandbox',
          ]);
        }
        expect(mockLogger.warn).not.toHaveBeenCalled();
      },
    );
  });

  describe('save points and forks', () => {
    const sourceId = '146794e4-0429-4e81-8fe2-e7fad9db2342';
    const logPath = join('.system_generated', 'logs', 'transcript_full.jsonl');
    const transcript = '{"type":"USER_INPUT","content":"parent turn"}\n';
    let store: string;
    let sourceLog: string;
    let input: PrepareSessionForkLaunchInput;

    beforeEach(async () => {
      store = await mkdtemp(join(tmpdir(), 'agy-save-point-'));
      const transcriptPath = join(store, 'conversations', `${sourceId}.db`);
      sourceLog = join(store, 'brain', sourceId, logPath);
      await mkdir(dirname(transcriptPath), { recursive: true });
      await mkdir(dirname(sourceLog), { recursive: true });
      await writeFile(sourceLog, transcript);
      createAntigravityFixtureDb(transcriptPath, sourceId, [{ input: 10, output: 5 }]);
      input = {
        providerSessionId: sourceId,
        transcriptPath,
        providerBinPath: '/usr/bin/agy',
        projectId: 'project',
        projectPath: '/project',
        sessionId: 'devchain-session',
        profileOptionArgs: ['--model', 'Gemini 4 Neon'],
        env: null,
        helperEnv: {},
      };
    });

    afterEach(async () => {
      await rm(store, { recursive: true, force: true });
    });

    // A real temporary DB distinguishes a WAL-aware backup from a file copy.
    it('copies the committed WAL and brain without changing the source or discovery files', async () => {
      const history = join(store, 'history.jsonl');
      const lastConversations = join(store, 'cache', 'last_conversations.json');
      const summaries = join(store, 'conversation_summaries.db');
      await mkdir(dirname(lastConversations));
      for (const index of [history, lastConversations, summaries]) {
        await writeFile(index, 'original index');
      }

      const source = new Database(input.transcriptPath);
      try {
        source.pragma('wal_autocheckpoint = 0');
        const generation = genMetadataBlob(20, 10);
        source
          .prepare('INSERT INTO gen_metadata VALUES (?, ?, ?)')
          .run(1, generation, generation.length);
        const mainFileBefore = await readFile(input.transcriptPath);
        const walPath = `${input.transcriptPath}-wal`;
        const walBefore = await readFile(walPath);
        expect(walBefore.byteLength).toBeGreaterThan(0);

        const saved = await adapter.createSavePoint(input);

        expect(saved.providerSessionId).not.toBe(sourceId);
        expect(saved.transcriptPath).toBe(
          join(store, 'conversations', `${saved.providerSessionId}.db`),
        );
        expect(
          new AntigravityMetricsReader().decode(saved.transcriptPath, saved.providerSessionId),
        ).toMatchObject({ inputTokens: 30, outputTokens: 15, warnings: [] });
        expect(await readFile(join(store, 'brain', saved.providerSessionId, logPath), 'utf8')).toBe(
          transcript,
        );
        expect(await readFile(input.transcriptPath)).toEqual(mainFileBefore);
        expect(await readFile(walPath)).toEqual(walBefore);
        expect(await readFile(sourceLog, 'utf8')).toBe(transcript);
        for (const index of [history, lastConversations, summaries]) {
          expect(await readFile(index, 'utf8')).toBe('original index');
        }
      } finally {
        source.close();
      }
    });

    // The adapter creates the ID shared by the restore args and the metrics reader.
    // A temporary SQLite and brain store lets the test verify that ID and which files discard removes.
    it.each([
      { prompt: '--prompt-interactive "read the project notes"' },
      { prompt: '-i "read the project notes"' },
      { prompt: '-i="read the project notes"' },
      { prompt: '--prompt="read the project notes"' },
      { prompt: '--print "read the project notes"' },
      { prompt: '-p="read the project notes"' },
      { project: '-project=project-a', prompt: '-prompt-interactive "read the notes"' },
      { project: '--project project-a', prompt: '--prompt-interactive="read the notes"' },
      { project: '-project project-a', prompt: '-prompt-interactive="read the notes"' },
      { project: '--project=project-a', prompt: '-prompt "read the notes"' },
      { project: '-project=project-a', prompt: '-print="read the notes"' },
    ])('drops $prompt from the child launch and can discard it', async ({ project, prompt }) => {
      const saved = await adapter.createSavePoint(input);
      const dbBefore = await readFile(saved.transcriptPath);

      const projectOption = project ?? '';
      const profileOptions = parseProfileOptions(`${projectOption} --model demo`);
      const child = await adapter.prepareForkLaunch({
        ...input,
        ...saved,
        profileOptionArgs: parseProfileOptions(`${projectOption} ${prompt} --model demo`),
      });

      expect(child.providerSessionId).not.toBe(saved.providerSessionId);
      expect(child.transcriptPath).toBe(
        join(store, 'conversations', `${child.providerSessionId}.db`),
      );
      expect(child.argv).toEqual(['--conversation', child.providerSessionId, ...profileOptions]);
      expect(
        new AntigravityMetricsReader().decode(child.transcriptPath, child.providerSessionId),
      ).toMatchObject({ inputTokens: 10, outputTokens: 5, warnings: [] });
      expect(await readFile(join(store, 'brain', child.providerSessionId, logPath), 'utf8')).toBe(
        transcript,
      );
      await child.discardUnboundTranscript!();
      await expect(readFile(child.transcriptPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(join(store, 'brain'))).not.toContain(child.providerSessionId);
      expect(await readFile(saved.transcriptPath)).toEqual(dbBefore);
    });

    it('forces inline settings in the fork argv from the fork version', async () => {
      const saved = await adapter.createSavePoint(input);
      const options = ['--settings', '{"theme":"dark"}', '-i', 'old prompt', '--model', 'demo'];

      const forced = await adapter.prepareForkLaunch({
        ...input,
        ...saved,
        cliVersion: '1.5.18',
        profileOptionArgs: options,
      });
      const unforced = await adapter.prepareForkLaunch({
        ...input,
        ...saved,
        profileOptionArgs: options,
      });

      expect(forced.argv).toEqual([
        '--conversation',
        forced.providerSessionId,
        '--settings',
        '{"theme":"dark","altScreenMode":"never"}',
        '--model',
        'demo',
      ]);
      expect(unforced.argv).toEqual([
        '--conversation',
        unforced.providerSessionId,
        '--settings',
        '{"theme":"dark"}',
        '--model',
        'demo',
      ]);
    });

    // A real symlink reaches brain validation after the adapter stages the SQLite backup.
    // The temporary store shows whether cleanup removes the entire partial copy.
    it('removes the partial copy after a brain copy fails validation', async () => {
      await symlink(sourceLog, join(dirname(sourceLog), 'linked.log'));
      const before = await readdir(store);

      await expect(adapter.createSavePoint(input)).rejects.toThrow('symbolic links');

      expect(await readdir(store)).toEqual(before);
      const conversations = await readdir(join(store, 'conversations'));
      expect(conversations.filter((name) => name.endsWith('.db'))).toEqual([`${sourceId}.db`]);
      expect(conversations.every((name) => name.startsWith(`${sourceId}.db`))).toBe(true);
      expect(await readdir(join(store, 'brain'))).toEqual([sourceId]);
    });

    // The fixture gives dot IDs real directories to resolve to. Calling the adapter directly
    // shows that it rejects the IDs before path resolution can lead to a database error.
    it.each(['.', '..'])(
      'rejects a conversation ID of %s before it selects a brain directory',
      async (id) => {
        await expect(
          adapter.createSavePoint({
            ...input,
            providerSessionId: id,
            transcriptPath: join(store, 'conversations', `${id}.db`),
          }),
        ).rejects.toThrow('The Antigravity transcript path does not match the conversation ID');
      },
    );
  });
});
