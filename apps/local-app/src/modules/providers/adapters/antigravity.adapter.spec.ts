import { AntigravityAdapter } from './antigravity.adapter';

describe('AntigravityAdapter', () => {
  let adapter: AntigravityAdapter;

  beforeEach(() => {
    adapter = new AntigravityAdapter();
  });

  describe('static capability surface', () => {
    it('identifies as the agy provider', () => {
      expect(adapter.providerName).toBe('agy');
    });

    it('runs as a full-screen alternate-screen TUI', () => {
      expect(adapter.terminalOutputBehavior?.usesAlternateScreen).toBe(true);
    });

    it('seeds the initial prompt via argv (spike (g): agy is argv-only)', () => {
      expect(adapter.initialPromptSeedMode).toBe('argv');
    });

    it('does NOT define launchInitialPromptBehavior (seeding handles the prompt, no paste)', () => {
      expect(adapter.launchInitialPromptBehavior).toBeUndefined();
    });

    it('declares DB-backed discovery requiring providerSessionId for restore', () => {
      expect(adapter.transcriptDiscoveryStrategy).toBe('all');
      expect(adapter.providerSessionIdRequiredForRestore).toBe(true);
    });

    it('is no longer MCP-deferred (P2-1 wires real agy MCP)', () => {
      expect((adapter as unknown as Record<string, unknown>).mcpDeferred).toBeUndefined();
    });

    it('requires project provisioning (workspace trust pre-write)', () => {
      expect(adapter.requiresProjectProvisioning).toBe(true);
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
    it('delegates to AntigravityTrustedWorkspacesService and maps warnings', async () => {
      const warning = {
        source: 'trusted_folders' as const,
        level: 'warn' as const,
        message: 'distrusted',
        code: 'AGY_TRUSTED_FOLDERS_DISTRUSTED',
      };
      const ensure = jest.fn().mockResolvedValue({ success: true, warnings: [warning] });
      const withService = new AntigravityAdapter({ ensure } as never);

      const result = await withService.provisionProjectPath('/home/user/project');

      expect(ensure).toHaveBeenCalledWith('/home/user/project');
      expect(result).toEqual({ success: true, warnings: [warning] });
    });

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

    it('omits the prompt flag for an empty-string prompt', () => {
      const { argv } = adapter.buildLaunchArgs({
        mode: 'new',
        profileOptionArgs: [],
        initialPrompt: '',
      });
      expect(argv).toEqual([]);
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
});
