import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DevinAdapter } from './devin.adapter';
import type { ProviderAdapter } from './provider-adapter.interface';
import { devinTranscriptPath } from '../../../common/devin-transcript-paths';

jest.mock('node:fs', () => {
  const actual = jest.requireActual('node:fs');
  return { ...actual, mkdirSync: jest.fn() };
});

const HOME = os.homedir();
const exportPathFor = (sid: string) => devinTranscriptPath(HOME, sid);

describe('DevinAdapter', () => {
  let adapter: DevinAdapter;
  const mkdirMock = fs.mkdirSync as jest.Mock;

  beforeEach(() => {
    mkdirMock.mockClear();
    adapter = new DevinAdapter();
  });

  describe('static capability surface', () => {
    it('has stop-hook traits and first-match discovery; restore needs providerSessionId', () => {
      expect(adapter.traits).toEqual({ activity: 'stop-hook', transcriptTurns: false, draftClearKeys: [] });
      expect(adapter.transcriptDiscoveryStrategy).toBe('first');
      expect(adapter.providerSessionIdRequiredForRestore).toBe(true);
      expect(adapter.initialPromptSeedMode).toBe('argv');
      expect((adapter as ProviderAdapter).terminalOutputBehavior).toBeUndefined();
    });
  });

  describe('buildLaunchArgs — new mode (--export binding + prompt after --)', () => {
    it('emits --export, trust flag, profile args, then -- <prompt> LAST', () => {
      const { argv } = adapter.buildLaunchArgs({
        mode: 'new',
        sessionId: 'sess-1',
        profileOptionArgs: ['--model', 'claude-fable-5-1-xhigh', '--permission-mode', 'dangerous'],
        initialPrompt: 'do the thing',
      });
      expect(argv).toEqual([
        '--export', exportPathFor('sess-1'),
        '--respect-workspace-trust', 'false',
        '--model', 'claude-fable-5-1-xhigh', '--permission-mode', 'dangerous',
        '--', 'do the thing',
      ]);
      expect(mkdirMock).toHaveBeenCalledWith(path.dirname(exportPathFor('sess-1')), {
        recursive: true, mode: 0o700,
      });
    });

    it('omits -- <prompt> when no initial prompt is configured', () => {
      const { argv } = adapter.buildLaunchArgs({
        mode: 'new', sessionId: 'sess-1', profileOptionArgs: [],
      });
      expect(argv).toEqual([
        '--export', exportPathFor('sess-1'),
        '--respect-workspace-trust', 'false',
      ]);
      expect(argv).not.toContain('--');
    });

    it('throws a clear error when sessionId is missing', () => {
      expect(() =>
        adapter.buildLaunchArgs({ mode: 'new', profileOptionArgs: [] }),
      ).toThrow(/sessionId/);
    });
  });

  describe('buildLaunchArgs — restore mode (-r + fresh --export)', () => {
    it('emits --resume <id> --export <newpath> --respect-workspace-trust false', () => {
      const { argv } = adapter.buildLaunchArgs({
        mode: 'restore',
        providerSessionId: 'functional-share',
        sessionId: 'sess-9',
        profileOptionArgs: ['--model', 'x'],
      });
      expect(argv).toEqual([
        '--resume', 'functional-share',
        '--export', exportPathFor('sess-9'),
        '--respect-workspace-trust', 'false',
        '--model', 'x',
      ]);
      expect(mkdirMock).toHaveBeenCalled();
    });

    it('still requires sessionId (the export path is devchain-owned)', () => {
      expect(() =>
        adapter.buildLaunchArgs({ mode: 'restore', providerSessionId: 'x', profileOptionArgs: [] }),
      ).toThrow(/sessionId/);
    });
  });

  describe('McpCliCapability', () => {
    it('builds the mcp add/list/remove argv shapes', () => {
      expect(adapter.addMcpServer({ endpoint: 'http://127.0.0.1:3000/mcp', alias: 'devchain' }))
        .toEqual(['mcp', 'add', '--transport', 'http', 'devchain', 'http://127.0.0.1:3000/mcp']);
      expect(adapter.addMcpServer({ endpoint: 'http://x/mcp', alias: 'a', extraArgs: ['--k', 'v'] }))
        .toEqual(['mcp', 'add', '--transport', 'http', 'a', 'http://x/mcp', '--k', 'v']);
      expect(adapter.listMcpServers()).toEqual(['mcp', 'list']);
      expect(adapter.removeMcpServer('devchain')).toEqual(['mcp', 'remove', 'devchain']);
    });

    it('parses `mcp list` bullet blocks — URL entries only (stdio skipped), CRLF-tolerant', () => {
      const out = [
        'Configured MCP servers',
        '',
        '  • code-review-graph',
        '    Command: C:\\tools\\code-review-graph.exe serve',
        '    Source: ~\\AppData\\Roaming\\devin\\mcp_config.json',
        '',
        '  • devchain',
        '    URL: http://127.0.0.1:3000/mcp',
        '    Source: ~\\AppData\\Local\\Temp\\x\\.devin\\mcp_config.local.json',
      ].join('\r\n');
      expect(adapter.parseListOutput(out)).toEqual([
        { alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp', transport: 'HTTP' },
      ]);
    });

    it('accepts * and - bullets and returns [] for header-only output', () => {
      expect(
        adapter.parseListOutput('  * a\n    URL: http://x/mcp\n  - b\n    Command: foo'),
      ).toEqual([{ alias: 'a', endpoint: 'http://x/mcp', transport: 'HTTP' }]);
      expect(adapter.parseListOutput('Configured MCP servers\n')).toEqual([]);
    });
  });

  describe('HookCapability', () => {
    it('builds the DEVCHAIN_* env incl. DEVCHAIN_HOOK_PROVIDER=devin', () => {
      const env = adapter.buildHookEnv({
        apiUrl: 'http://127.0.0.1:3000', projectId: 'p', agentId: 'a',
        sessionId: 's', tmuxSessionName: 't',
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
