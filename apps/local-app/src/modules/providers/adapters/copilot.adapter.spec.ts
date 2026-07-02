import { CopilotAdapter } from './copilot.adapter';
import { isHookCapable } from './capabilities';

describe('CopilotAdapter', () => {
  let adapter: CopilotAdapter;

  beforeEach(() => {
    adapter = new CopilotAdapter();
  });

  describe('static capability surface', () => {
    it('identifies as the copilot provider', () => {
      expect(adapter.providerName).toBe('copilot');
    });

    it('runs as a full-screen alternate-screen TUI', () => {
      expect(adapter.terminalOutputBehavior?.usesAlternateScreen).toBe(true);
    });

    it('seeds the initial prompt via argv (-i)', () => {
      expect(adapter.initialPromptSeedMode).toBe('argv');
    });

    it('does NOT define launchInitialPromptBehavior (seeding handles the prompt, no paste)', () => {
      expect(adapter.launchInitialPromptBehavior).toBeUndefined();
    });

    it('declares deterministic first-match discovery (S2) requiring providerSessionId for restore', () => {
      expect(adapter.transcriptDiscoveryStrategy).toBe('first');
      expect(adapter.providerSessionIdRequiredForRestore).toBe(true);
    });

    it('requires project provisioning (trust pre-write, S1 Branch B)', () => {
      expect(adapter.requiresProjectProvisioning).toBe(true);
    });

    it('guards COPILOT_HOME on both surfaces — strip ambient + reject explicit (R4)', () => {
      // Ambient/inherited COPILOT_HOME is stripped from the child env...
      expect(adapter.launchUnsetEnv).toEqual(['COPILOT_HOME']);
      // ...and an explicit provider/config COPILOT_HOME is hard-rejected.
      expect(adapter.launchRejectEnv).toEqual(['COPILOT_HOME']);
    });
  });

  describe('HookCapability (2nd adopter; P3 lifecycle hooks)', () => {
    it('is recognized as hook-capable by the type guard', () => {
      expect(isHookCapable(adapter)).toBe(true);
    });

    it('enables hooks and reuses the legacy provider-neutral event name (decision: option b)', () => {
      expect(adapter.hooksEnabled).toBe(true);
      // Same internal devchain event as Claude → 0005 renew-instructions seeder +
      // event-fields catalog fire for Copilot with ZERO seeder churn.
      expect(adapter.hooksEventName).toBe('claude.hooks.session.started');
    });

    it('declares hooksProvideTranscriptPath=false (Copilot sessionStart carries no path)', () => {
      expect(adapter.hooksProvideTranscriptPath).toBe(false);
    });

    it('builds the DEVCHAIN_* hook env (same contract as Claude)', () => {
      const env = adapter.buildHookEnv({
        apiUrl: 'http://127.0.0.1:3000',
        projectId: 'proj-1',
        agentId: 'agent-1',
        sessionId: 'sess-1',
        tmuxSessionName: 'devchain-sess-1',
      });

      expect(env).toEqual({
        DEVCHAIN_API_URL: 'http://127.0.0.1:3000',
        DEVCHAIN_PROJECT_ID: 'proj-1',
        DEVCHAIN_AGENT_ID: 'agent-1',
        DEVCHAIN_SESSION_ID: 'sess-1',
        DEVCHAIN_TMUX_SESSION_NAME: 'devchain-sess-1',
      });
    });
  });

  describe('probeAuth (best-effort, non-blocking)', () => {
    it('reports authenticated and always returns the remediation string', async () => {
      const isAuthenticated = jest.fn().mockResolvedValue(true);
      const withProbe = new CopilotAdapter(undefined as never, { isAuthenticated } as never);

      const result = await withProbe.probeAuth();

      expect(isAuthenticated).toHaveBeenCalled();
      expect(result.authenticated).toBe(true);
      expect(result.remediation).toContain('copilot login');
    });

    it('reports not-authenticated with remediation when the probe is negative', async () => {
      const isAuthenticated = jest.fn().mockResolvedValue(false);
      const withProbe = new CopilotAdapter(undefined as never, { isAuthenticated } as never);

      const result = await withProbe.probeAuth();

      expect(result.authenticated).toBe(false);
      expect(result.remediation).toContain('COPILOT_GITHUB_TOKEN');
    });
  });

  describe('provisionProjectPath (folder trust)', () => {
    it('delegates to CopilotTrustedFoldersService and passes warnings through', async () => {
      const warning = {
        source: 'trusted_folders' as const,
        level: 'warn' as const,
        message: 'config malformed',
        code: 'COPILOT_CONFIG_MALFORMED',
      };
      const ensure = jest.fn().mockResolvedValue({ success: false, warnings: [warning] });
      const withService = new CopilotAdapter({ ensure } as never);

      const result = await withService.provisionProjectPath('/home/user/project');

      expect(ensure).toHaveBeenCalledWith('/home/user/project');
      expect(result).toEqual({ success: true, warnings: [warning] });
    });

    it('returns success with no warnings on a clean trust write', async () => {
      const ensure = jest.fn().mockResolvedValue({ success: true, warnings: [] });
      const withService = new CopilotAdapter({ ensure } as never);

      const result = await withService.provisionProjectPath('/home/user/project');

      expect(result).toEqual({ success: true, warnings: [] });
    });

    it('never throws — a service failure becomes a provisioning warning', async () => {
      const ensure = jest.fn().mockRejectedValue(new Error('disk on fire'));
      const withService = new CopilotAdapter({ ensure } as never);

      const result = await withService.provisionProjectPath('/home/user/project');

      expect(result.success).toBe(true);
      expect(result.warnings).toEqual([
        expect.objectContaining({
          message: 'disk on fire',
          code: 'COPILOT_TRUST_PROVISION_FAILED',
        }),
      ]);
    });
  });

  describe('buildLaunchArgs — new mode (deterministic --session-id binding)', () => {
    it('always passes --session-id and seeds the prompt via -i', () => {
      const { argv } = adapter.buildLaunchArgs({
        mode: 'new',
        sessionId: 'sess-uuid-123',
        profileOptionArgs: ['--model', 'claude-sonnet-4'],
        initialPrompt: 'do the thing',
      });
      expect(argv).toEqual([
        '--session-id',
        'sess-uuid-123',
        '-i',
        'do the thing',
        '--model',
        'claude-sonnet-4',
      ]);
    });

    it('omits -i when no initial prompt is configured but still binds --session-id', () => {
      const { argv } = adapter.buildLaunchArgs({
        mode: 'new',
        sessionId: 'sess-uuid-123',
        profileOptionArgs: ['--allow-all-tools'],
      });
      expect(argv).toEqual(['--session-id', 'sess-uuid-123', '--allow-all-tools']);
      expect(argv).not.toContain('-i');
    });

    it('omits -i for an empty-string prompt', () => {
      const { argv } = adapter.buildLaunchArgs({
        mode: 'new',
        sessionId: 'sess-uuid-123',
        profileOptionArgs: [],
        initialPrompt: '',
      });
      expect(argv).toEqual(['--session-id', 'sess-uuid-123']);
    });
  });

  describe('buildLaunchArgs — restore mode (--resume, fail-closed, never --continue)', () => {
    it('restores via --resume=<providerSessionId> with profile args following', () => {
      const { argv } = adapter.buildLaunchArgs({
        mode: 'restore',
        providerSessionId: '146794e4-0429-4e81-8fe2-e7fad9db2342',
        profileOptionArgs: ['--model', 'x'],
      });
      expect(argv).toEqual(['--resume=146794e4-0429-4e81-8fe2-e7fad9db2342', '--model', 'x']);
    });

    it('never emits --continue and does NOT seed an initial prompt on restore', () => {
      const { argv } = adapter.buildLaunchArgs({
        mode: 'restore',
        providerSessionId: 'sess-1',
        profileOptionArgs: [],
        initialPrompt: 'should be ignored',
      });
      expect(argv).toEqual(['--resume=sess-1']);
      expect(argv).not.toContain('should be ignored');
      expect(argv).not.toContain('--continue');
    });

    it('does NOT pass --session-id on restore (binds via --resume only)', () => {
      const { argv } = adapter.buildLaunchArgs({
        mode: 'restore',
        providerSessionId: 'sess-1',
        sessionId: 'new-launch-id-should-be-ignored',
        profileOptionArgs: [],
      });
      expect(argv).not.toContain('--session-id');
    });
  });

  describe('McpCliCapability — Copilot MCP CLI command shapes (R3)', () => {
    it('adds a remote HTTP server with no --header (loopback-no-auth)', () => {
      const args = adapter.addMcpServer({
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });
      expect(args).toEqual([
        'mcp',
        'add',
        '--transport',
        'http',
        'devchain',
        'http://127.0.0.1:3000/mcp',
      ]);
      expect(args).not.toContain('--header');
    });

    it('defaults the alias to the provider name when omitted', () => {
      const args = adapter.addMcpServer({ endpoint: 'http://x/mcp' });
      expect(args).toContain('copilot');
    });

    it('appends extraArgs when provided', () => {
      const args = adapter.addMcpServer({
        endpoint: 'http://x/mcp',
        alias: 'devchain',
        extraArgs: ['--tools', '*'],
      });
      expect(args.slice(-2)).toEqual(['--tools', '*']);
    });

    it('lists servers in pipe-safe JSON mode', () => {
      expect(adapter.listMcpServers()).toEqual(['mcp', 'list', '--json']);
    });

    it('removes a server by alias', () => {
      expect(adapter.removeMcpServer('devchain')).toEqual(['mcp', 'remove', 'devchain']);
    });

    it('probes a server via mcp get <alias>', () => {
      expect(adapter.binaryCheck('devchain')).toEqual(['mcp', 'get', 'devchain']);
    });
  });

  describe('parseListOutput — copilot mcp list --json', () => {
    it('parses mcpServers[].url/type into discovered entries', () => {
      const entries = adapter.parseListOutput(
        JSON.stringify({
          mcpServers: {
            devchain: {
              tools: ['*'],
              type: 'http',
              url: 'http://127.0.0.1:3000/mcp',
              source: 'user',
            },
          },
        }),
      );
      expect(entries).toEqual([
        { alias: 'devchain', endpoint: 'http://127.0.0.1:3000/mcp', transport: 'HTTP' },
      ]);
    });

    it('returns no entries for an empty/serverless config object', () => {
      expect(adapter.parseListOutput(JSON.stringify({ mcpServers: {} }))).toEqual([]);
      expect(adapter.parseListOutput(JSON.stringify({}))).toEqual([]);
    });

    it('skips entries without a url', () => {
      const entries = adapter.parseListOutput(
        JSON.stringify({ mcpServers: { local: { type: 'stdio', command: 'foo' } } }),
      );
      expect(entries).toEqual([]);
    });

    it('returns no entries for non-JSON output (does not throw)', () => {
      expect(adapter.parseListOutput('not json at all')).toEqual([]);
    });
  });
});
