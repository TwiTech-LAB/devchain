import * as fs from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DevinAdapter } from './devin.adapter';
import { parseProfileOptions } from '../utils/profile-options';
import type { ProviderAdapter } from './provider-adapter.interface';
import {
  DEVIN_STORE_SESSIONS_DIR,
  devinSessionStorePath,
  devinTranscriptPath,
} from '../../../common/devin-transcript-paths';
import { SESSION_START_SOURCE_ENV } from './capabilities/hook.capability';

jest.mock('node:os', () => {
  const actual = jest.requireActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: jest.fn(actual.homedir) };
});
const realHomedir = jest.requireActual<typeof import('node:os')>('node:os').homedir;
const homedirMock = os.homedir as jest.Mock;

const HOME = os.homedir();
const exportPathFor = (sid: string) => devinTranscriptPath(HOME, sid);

describe('DevinAdapter', () => {
  let adapter: DevinAdapter;
  beforeEach(() => {
    adapter = new DevinAdapter();
  });

  describe('static capability surface', () => {
    it('has stop-hook traits and first-match discovery; restore needs providerSessionId', () => {
      expect(adapter.traits).toEqual({
        activity: 'stop-hook',
        transcriptTurns: false,
        draftClearKeys: ['C-c'],
      });
      expect(adapter.runtimePromptBehavior).toEqual({ inputPromptMarker: '❭' });
      expect(adapter.transcriptDiscoveryStrategy).toBe('first');
      expect(adapter.providerSessionIdRequiredForRestore).toBe(true);
      expect(adapter.transcriptAppearsAfterTurn).toBe(true);
      expect(adapter.initialPromptSeedMode).toBe('argv');
      expect((adapter as ProviderAdapter).terminalOutputBehavior).toBeUndefined();
    });
  });

  describe('buildLaunchArgs — new mode (--export binding + prompt after --)', () => {
    it('emits --export, trust flag, profile args, then -- <prompt> LAST', () => {
      const { argv } = adapter.buildLaunchArgs({
        mode: 'new',
        sessionId: 'sess-1',
        projectId: 'proj-1',
        profileOptionArgs: ['--model', 'claude-fable-5-1-xhigh', '--permission-mode', 'dangerous'],
        initialPrompt: 'do the thing',
      });
      expect(argv).toEqual([
        '--export',
        exportPathFor('sess-1'),
        '--respect-workspace-trust',
        'false',
        '--model',
        'claude-fable-5-1-xhigh',
        '--permission-mode',
        'dangerous',
        '--',
        'do the thing',
      ]);
    });

    it('omits -- <prompt> when no initial prompt is configured', () => {
      const { argv } = adapter.buildLaunchArgs({
        mode: 'new',
        sessionId: 'sess-1',
        projectId: 'proj-1',
        profileOptionArgs: [],
      });
      expect(argv).toEqual([
        '--export',
        exportPathFor('sess-1'),
        '--respect-workspace-trust',
        'false',
      ]);
      expect(argv).not.toContain('--');
    });

    it('throws a clear error when sessionId is missing', () => {
      expect(() => adapter.buildLaunchArgs({ mode: 'new', profileOptionArgs: [] })).toThrow(
        /sessionId/,
      );
    });
  });

  describe('buildLaunchArgs — restore mode (-r + fresh --export)', () => {
    it('emits --resume <id> --export <newpath> --respect-workspace-trust false', () => {
      const { argv } = adapter.buildLaunchArgs({
        mode: 'restore',
        providerSessionId: 'functional-share',
        sessionId: 'sess-9',
        projectId: 'proj-1',
        profileOptionArgs: ['--model', 'x'],
      });
      expect(argv).toEqual([
        '--resume',
        'functional-share',
        '--export',
        exportPathFor('sess-9'),
        '--respect-workspace-trust',
        'false',
        '--model',
        'x',
      ]);
    });

    it('still requires sessionId (the export path is devchain-owned)', () => {
      expect(() =>
        adapter.buildLaunchArgs({ mode: 'restore', providerSessionId: 'x', profileOptionArgs: [] }),
      ).toThrow(/sessionId/);
    });
  });

  describe('buildLaunchArgs — per-project session store env', () => {
    it.each([
      { mode: 'new' as const },
      { mode: 'restore' as const, providerSessionId: 'functional-share' },
    ])('$mode keeps the input env and selects the project store', (input) => {
      const { env } = adapter.buildLaunchArgs({
        ...input,
        sessionId: 'sess-1',
        projectId: 'proj-1',
        profileOptionArgs: [],
        env: { PROFILE_KEY: 'profile', PATH: '/shim:/usr/bin' },
      });
      expect(env).toEqual({
        PROFILE_KEY: 'profile',
        PATH: '/shim:/usr/bin',
        DEVIN_SESSION_STORE: 'files',
        DEVIN_SESSIONS_DIR: devinSessionStorePath(HOME, 'proj-1'),
      });
    });

    it('throws a clear error when projectId is missing', () => {
      expect(() =>
        adapter.buildLaunchArgs({ mode: 'new', sessionId: 'sess-1', profileOptionArgs: [] }),
      ).toThrow(/projectId/);
    });
  });

  it('buildLaunchArgs creates nothing on disk in either mode', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-home-'));
    homedirMock.mockReturnValue(home);
    try {
      adapter.buildLaunchArgs({
        mode: 'new',
        sessionId: 's1',
        projectId: 'p1',
        profileOptionArgs: [],
      });
      adapter.buildLaunchArgs({
        mode: 'restore',
        providerSessionId: 'functional-share',
        sessionId: 's2',
        projectId: 'p1',
        profileOptionArgs: [],
      });
      expect(fs.readdirSync(home)).toEqual([]);
    } finally {
      homedirMock.mockImplementation(realHomedir);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  describe('ConfigFileMcpCapability (project_config — NOT CLI mode)', () => {
    it('declares project_config mode targeting .devin/mcp_config.local.json under mcpServers', () => {
      // `devin mcp remove` cannot touch foreign-config entries, so MCP must go
      // through the config file.
      expect(adapter.mcpMode).toBe('project_config');
      expect(adapter.configFileName).toBe('.devin/mcp_config.local.json');
      expect(adapter.mcpConfigRootKey).toBe('mcpServers');
    });

    it('exposes no CLI MCP methods (addMcpServer/listMcpServers/removeMcpServer/parseListOutput)', () => {
      const cliSurface = adapter as unknown as Record<string, unknown>;
      expect(cliSurface.addMcpServer).toBeUndefined();
      expect(cliSurface.listMcpServers).toBeUndefined();
      expect(cliSurface.removeMcpServer).toBeUndefined();
      expect(cliSurface.parseListOutput).toBeUndefined();
    });
  });

  describe('parseProjectConfig (.devin/mcp_config.local.json)', () => {
    it('parses the real devin file shape — url entries only, stdio skipped', () => {
      // Shape verified against `devin mcp add` (v3000.11.234): http servers carry
      // { url, transport: 'http' }; stdio servers carry { command, args } with
      // no url and must be skipped.
      const content = JSON.stringify({
        mcpServers: {
          devchain: { url: 'http://127.0.0.1:3000/mcp', transport: 'http' },
          teststdio: { command: 'echo', args: ['hello'], transport: 'stdio' },
        },
      });

      expect(adapter.parseProjectConfig(content)).toEqual([
        { alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp', transport: 'HTTP' },
      ]);
    });

    it('returns multiple url entries with uppercased transport', () => {
      const content = JSON.stringify({
        mcpServers: {
          a: { url: 'http://x/mcp', transport: 'http' },
          b: { url: 'http://y/sse', transport: 'sse' },
        },
      });

      expect(adapter.parseProjectConfig(content)).toEqual([
        { alias: 'a', endpoint: 'http://x/mcp', transport: 'HTTP' },
        { alias: 'b', endpoint: 'http://y/sse', transport: 'SSE' },
      ]);
    });

    it('defaults transport to HTTP when missing and skips non-object/url-less values', () => {
      const content = JSON.stringify({
        mcpServers: {
          bare: { url: 'http://z/mcp' },
          stdio: { command: 'foo', args: [] },
          weird: 'not-an-object',
          nil: null,
        },
      });

      expect(adapter.parseProjectConfig(content)).toEqual([
        { alias: 'bare', endpoint: 'http://z/mcp', transport: 'HTTP' },
      ]);
    });

    it('returns [] when mcpServers is missing or not an object', () => {
      expect(adapter.parseProjectConfig(JSON.stringify({ other: 1 }))).toEqual([]);
      expect(adapter.parseProjectConfig(JSON.stringify({ mcpServers: {} }))).toEqual([]);
      expect(adapter.parseProjectConfig(JSON.stringify({ mcpServers: 'oops' }))).toEqual([]);
      expect(adapter.parseProjectConfig('null')).toEqual([]);
    });

    it('throws on malformed JSON (caller responsibility)', () => {
      expect(() => adapter.parseProjectConfig('not valid json')).toThrow(SyntaxError);
    });
  });

  describe('buildMcpConfigEntry', () => {
    it('returns the devin mcp add shape under mcpServers', () => {
      expect(adapter.buildMcpConfigEntry({ endpoint: 'http://127.0.0.1:3000/mcp' })).toEqual({
        key: 'devchain',
        value: { url: 'http://127.0.0.1:3000/mcp', transport: 'http' },
      });
    });

    it('honours a custom alias', () => {
      expect(adapter.buildMcpConfigEntry({ endpoint: 'http://x/mcp', alias: 'my-server' })).toEqual(
        {
          key: 'my-server',
          value: { url: 'http://x/mcp', transport: 'http' },
        },
      );
    });
  });

  // A temporary store exercises real writes and renames. The adapter returns the launch
  // argv and environment directly, so the same fixture can check Restore parity.
  describe('session forks', () => {
    const projectId = 'project-1';
    const providerSessionId = 'brave-otter';
    const sourceRowId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const targetRowId = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const meta = '{ "id": "brave-otter", "title": "Original" }\n';
    const log = '{"type":"message","text":"first turn"}\n';
    const transcript = '{ "session_id": "brave-otter", "steps": [{"message":"first turn"}] }\n';
    let home: string;
    let sessionsDir: string;
    let sourceDir: string;
    let sourcePath: string;
    let targetPath: string;

    beforeEach(async () => {
      home = await mkdtemp(path.join(os.tmpdir(), 'devin-fork-'));
      homedirMock.mockReturnValue(home);
      sessionsDir = path.join(devinSessionStorePath(home, projectId), DEVIN_STORE_SESSIONS_DIR);
      sourceDir = path.join(sessionsDir, providerSessionId);
      sourcePath = devinTranscriptPath(home, sourceRowId);
      targetPath = devinTranscriptPath(home, targetRowId);
      await mkdir(sourceDir, { recursive: true });
      await writeFile(path.join(sourceDir, 'meta.json'), meta);
      await writeFile(path.join(sourceDir, 'log.jsonl'), log);
      await writeFile(sourcePath, transcript);
    });

    afterEach(async () => {
      homedirMock.mockImplementation(realHomedir);
      await rm(home, { recursive: true, force: true });
    });

    const copyInput = () => ({
      projectId,
      projectPath: '/test/project',
      providerBinPath: 'devin',
      sessionId: targetRowId,
      providerSessionId,
      transcriptPath: sourcePath,
      env: { DEVCHAIN_SESSION_ID: targetRowId },
      helperEnv: {},
    });

    it('saves a separate store and export with the new provider ID', async () => {
      const saved = await adapter.createSavePoint(copyInput());
      expect(saved.providerSessionId).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(saved.providerSessionId).not.toBe(providerSessionId);
      expect(saved.transcriptPath).toBe(targetPath);
      const targetDir = path.join(sessionsDir, saved.providerSessionId);
      expect(JSON.parse(await readFile(path.join(targetDir, 'meta.json'), 'utf8'))).toEqual({
        ...JSON.parse(meta),
        id: saved.providerSessionId,
      });
      expect(await readFile(path.join(targetDir, 'log.jsonl'), 'utf8')).toBe(log);
      expect(JSON.parse(await readFile(targetPath, 'utf8'))).toEqual({
        ...JSON.parse(transcript),
        session_id: saved.providerSessionId,
      });
      expect(await readFile(path.join(sourceDir, 'meta.json'), 'utf8')).toBe(meta);
      expect(await readFile(path.join(sourceDir, 'log.jsonl'), 'utf8')).toBe(log);
      expect(await readFile(sourcePath, 'utf8')).toBe(transcript);
    });

    it.each([
      { flags: '--prompt-file "startup notes.txt"', tail: '' },
      { flags: '--prompt-file="startup notes.txt"', tail: '' },
      { flags: '-p "read the project notes"', tail: '' },
      { flags: '--print="read the project notes"', tail: '' },
      { flags: '--print', tail: '' },
      { flags: '-cp "read the notes"', tail: '', kept: ['-c'] },
      { flags: '-cp="read the notes"', tail: '', kept: ['-c'] },
      { flags: '-cp', tail: '', kept: ['-c'] },
      { flags: '', tail: '-- read the project notes --model=prompt-text' },
    ])('drops startup text from the fork profile ($flags $tail)', async ({ flags, tail, kept }) => {
      const options = ['--model', 'swe-2-flash-medium', '--permission-mode', 'plan', '/workspace'];
      const expected = [...(kept ?? []), ...options];
      const input = {
        ...copyInput(),
        profileOptionArgs: [
          ...parseProfileOptions(flags),
          ...options,
          ...parseProfileOptions(tail),
        ],
      };
      const fork = await adapter.prepareForkLaunch(input);
      expect(fork).toMatchObject({
        ...adapter.buildLaunchArgs({
          ...input,
          mode: 'restore',
          providerSessionId: fork.providerSessionId,
          profileOptionArgs: expected,
        }),
        transcriptPath: targetPath,
      });
      expect(fork.argv).toEqual([
        '--resume',
        fork.providerSessionId,
        '--export',
        targetPath,
        '--respect-workspace-trust',
        'false',
        ...expected,
      ]);
      expect(fork.env).toEqual({
        DEVCHAIN_SESSION_ID: targetRowId,
        DEVIN_SESSION_STORE: 'files',
        DEVIN_SESSIONS_DIR: devinSessionStorePath(home, projectId),
      });
      expect(adapter.forkReadsSavePointTranscript).toBe(true);
    });

    // A rollback targets a row that owns an export already; it must survive until commit.
    it.each([
      { label: 'no export, then discard', prior: false, end: 'discard', exported: 'none' },
      { label: 'an export, then discard', prior: true, end: 'discard', exported: 'prior' },
      { label: 'an export, then commit', prior: true, end: 'commit', exported: 'copy' },
      { label: 'an export, then an error', prior: true, end: 'error', exported: 'prior' },
    ] as const)('protects the target export: $label', async ({ prior, end, exported }) => {
      const priorId = 'calm-heron';
      const priorExport = '{ "session_id": "calm-heron", "steps": [] }\n';
      if (prior) {
        await mkdir(path.join(sessionsDir, priorId));
        await writeFile(path.join(sessionsDir, priorId, 'log.jsonl'), log);
        await writeFile(targetPath, priorExport);
      }
      const input = { ...copyInput(), profileOptionArgs: [] };
      let copyId: string | null = null;
      if (end === 'error') {
        jest.spyOn(adapter, 'buildLaunchArgs').mockImplementationOnce(() => {
          throw new Error('launch failed');
        });
        await expect(adapter.prepareForkLaunch(input)).rejects.toThrow('launch failed');
      } else {
        const fork = await adapter.prepareForkLaunch(input);
        copyId = fork.providerSessionId;
        await (end === 'commit' ? fork.commitBoundTranscript : fork.discardUnboundTranscript)?.();
      }

      const stores = [
        providerSessionId,
        ...(prior ? [priorId] : []),
        ...(copyId && end === 'commit' ? [copyId] : []),
      ];
      expect((await readdir(sessionsDir)).sort()).toEqual(stores.sort());
      if (prior) {
        expect(await readdir(path.join(sessionsDir, priorId))).toEqual(['log.jsonl']);
        expect(await readFile(path.join(sessionsDir, priorId, 'log.jsonl'), 'utf8')).toBe(log);
      }
      const exportName = path.basename(targetPath);
      const leftovers = (await readdir(path.dirname(targetPath))).filter((name) =>
        name.startsWith(`${exportName}.`),
      );
      expect(leftovers).toEqual([]);
      if (exported === 'none') {
        await expect(readFile(targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
      } else if (exported === 'prior') {
        expect(await readFile(targetPath, 'utf8')).toBe(priorExport);
      } else {
        expect(JSON.parse(await readFile(targetPath, 'utf8'))).toMatchObject({
          session_id: copyId,
        });
      }
    });

    it('removes the copied store and temporary export if export publication fails', async () => {
      await mkdir(targetPath);
      await expect(adapter.createSavePoint(copyInput())).rejects.toThrow();

      expect(await readdir(sessionsDir)).toEqual([providerSessionId]);
      expect(await readdir(path.dirname(targetPath))).toEqual(
        expect.arrayContaining([path.basename(sourcePath), path.basename(targetPath), 'stores']),
      );
      expect(await readdir(path.dirname(targetPath))).toHaveLength(3);
    });
  });

  describe('HookCapability', () => {
    // The adapter owns the hook environment and exposes it before launch.
    it.each([
      { context: 'new or restore', sessionStartSource: undefined },
      { context: 'fork', sessionStartSource: 'fork' },
    ] as const)('builds the hook environment for $context', ({ sessionStartSource }) => {
      const env = adapter.buildHookEnv({
        apiUrl: 'http://127.0.0.1:3000',
        projectId: 'p',
        agentId: 'a',
        sessionId: 's',
        tmuxSessionName: 't',
        sessionStartSource,
      });
      expect(env).toEqual({
        DEVCHAIN_API_URL: 'http://127.0.0.1:3000',
        DEVCHAIN_PROJECT_ID: 'p',
        DEVCHAIN_AGENT_ID: 'a',
        DEVCHAIN_SESSION_ID: 's',
        DEVCHAIN_TMUX_SESSION_NAME: 't',
        DEVCHAIN_HOOK_PROVIDER: 'devin',
        ...(sessionStartSource && { [SESSION_START_SOURCE_ENV]: sessionStartSource }),
      });
      expect(adapter.hooksEnabled).toBe(true);
      expect(adapter.hooksProvideTranscriptPath).toBe(false);
      expect(adapter.managedHookEnvKeys).toContain(SESSION_START_SOURCE_ENV);
    });
  });
});
