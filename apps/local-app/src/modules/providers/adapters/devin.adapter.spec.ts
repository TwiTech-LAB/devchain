import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DevinAdapter } from './devin.adapter';
import type { ProviderAdapter } from './provider-adapter.interface';
import { devinSessionStorePath, devinTranscriptPath } from '../../../common/devin-transcript-paths';

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

  describe('HookCapability', () => {
    it('builds the DEVCHAIN_* env incl. DEVCHAIN_HOOK_PROVIDER=devin', () => {
      const env = adapter.buildHookEnv({
        apiUrl: 'http://127.0.0.1:3000',
        projectId: 'p',
        agentId: 'a',
        sessionId: 's',
        tmuxSessionName: 't',
      });
      expect(env).toEqual({
        DEVCHAIN_API_URL: 'http://127.0.0.1:3000',
        DEVCHAIN_PROJECT_ID: 'p',
        DEVCHAIN_AGENT_ID: 'a',
        DEVCHAIN_SESSION_ID: 's',
        DEVCHAIN_TMUX_SESSION_NAME: 't',
        DEVCHAIN_HOOK_PROVIDER: 'devin',
      });
      expect(adapter.hooksEnabled).toBe(true);
      expect(adapter.hooksProvideTranscriptPath).toBe(false);
    });
  });
});
