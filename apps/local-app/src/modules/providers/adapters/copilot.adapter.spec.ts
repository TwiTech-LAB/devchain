import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'fs/promises';
import os from 'os';
import { join } from 'path';
import { parse } from 'yaml';
import { CopilotAdapter } from './copilot.adapter';
import { parseProfileOptions } from '../utils/profile-options';
import { SESSION_START_SOURCE_ENV } from './capabilities/hook.capability';

import type { ProviderAdapter } from './provider-adapter.interface';

describe('CopilotAdapter', () => {
  let adapter: CopilotAdapter;

  beforeEach(() => {
    adapter = new CopilotAdapter(
      { ensure: jest.fn() } as never,
      { isAuthenticated: jest.fn() } as never,
    );
  });

  describe('static capability surface', () => {
    it('runs as a full-screen alternate-screen TUI', () => {
      expect(adapter.terminalOutputBehavior?.usesAlternateScreen).toBe(true);
    });

    it('seeds the initial prompt via argv (-i)', () => {
      expect(adapter.initialPromptSeedMode).toBe('argv');
    });

    it('does NOT define launchInitialPromptBehavior (seeding handles the prompt, no paste)', () => {
      const asProvider: ProviderAdapter = adapter;
      expect(asProvider.launchInitialPromptBehavior).toBeUndefined();
    });

    it('declares deterministic first-match discovery (S2) requiring providerSessionId for restore', () => {
      expect(adapter.transcriptDiscoveryStrategy).toBe('first');
      expect(adapter.providerSessionIdRequiredForRestore).toBe(true);
    });

    it('guards COPILOT_HOME on both surfaces — strip ambient + reject explicit (R4)', () => {
      // Ambient/inherited COPILOT_HOME is stripped from the child env...
      expect(adapter.launchUnsetEnv).toEqual(['COPILOT_HOME']);
      // ...and an explicit provider/config COPILOT_HOME is hard-rejected.
      expect(adapter.launchRejectEnv).toEqual(['COPILOT_HOME']);
    });
  });

  describe('EffortCapability', () => {
    it('injects the native `--effort=<value>` form', () => {
      const { argv } = adapter.applyEffort(['-m', 'gpt-5'], {}, 'high');
      expect(argv).toEqual(['--effort=high', '-m', 'gpt-5']);
    });

    it('strips conflicting raw `--effort` AND the `--reasoning-effort` alias (both value forms)', () => {
      expect(
        adapter.applyEffort(['--effort', 'low', '--reasoning-effort=minimal', '-x'], {}, 'high')
          .argv,
      ).toEqual(['--effort=high', '-x']);
      expect(
        adapter.applyEffort(['--effort=low', '--reasoning-effort', 'minimal', '-x'], {}, 'high')
          .argv,
      ).toEqual(['--effort=high', '-x']);
    });

    it('returns env unchanged', () => {
      const env = { FOO: 'bar' };
      expect(adapter.applyEffort([], env, 'medium').env).toBe(env);
    });
  });

  describe('HookCapability (2nd adopter; P3 lifecycle hooks)', () => {
    it('enables hooks', () => {
      expect(adapter.hooksEnabled).toBe(true);
    });

    it('declares hooksProvideTranscriptPath=false (Copilot sessionStart carries no path)', () => {
      expect(adapter.hooksProvideTranscriptPath).toBe(false);
    });

    it.each([undefined, 'fork'] as const)('builds hook env for source %s', (sessionStartSource) => {
      expect(adapter.managedHookEnvKeys).toContain(SESSION_START_SOURCE_ENV);
      const env = adapter.buildHookEnv({
        apiUrl: 'http://127.0.0.1:3000',
        projectId: 'proj-1',
        agentId: 'agent-1',
        sessionId: 'sess-1',
        tmuxSessionName: 'devchain-sess-1',
        sessionStartSource,
      });

      expect(env).toEqual({
        DEVCHAIN_API_URL: 'http://127.0.0.1:3000',
        DEVCHAIN_PROJECT_ID: 'proj-1',
        DEVCHAIN_AGENT_ID: 'agent-1',
        DEVCHAIN_SESSION_ID: 'sess-1',
        DEVCHAIN_TMUX_SESSION_NAME: 'devchain-sess-1',
        ...(sessionStartSource && { [SESSION_START_SOURCE_ENV]: sessionStartSource }),
      });
    });
  });

  describe('SessionForkCapability', () => {
    const parentId = '9f6b57af-936c-4a40-bdb9-c343503d114f';
    const savePointId = '9d486da3-71a6-403e-986e-c9a0fbf8352b';
    const childId = '07cff598-83e1-4ad9-8c6d-dfd89015c4ba';
    let fakeHome: string;
    let stateDir: string;
    let parentDir: string;
    let input: Parameters<CopilotAdapter['createSavePoint']>[0];

    beforeEach(async () => {
      fakeHome = await mkdtemp(join(os.tmpdir(), 'copilot-save-point-'));
      jest.spyOn(os, 'homedir').mockReturnValue(fakeHome);
      stateDir = join(fakeHome, '.copilot', 'session-state');
      parentDir = join(stateDir, parentId);
      await mkdir(parentDir, { recursive: true });
      input = {
        providerSessionId: parentId,
        transcriptPath: join(parentDir, 'events.jsonl'),
        sessionId: savePointId,
        projectId: 'project',
        projectPath: '/project',
        providerBinPath: 'copilot',
        env: null,
        helperEnv: {},
      };
    });

    afterEach(async () => {
      jest.restoreAllMocks();
      await rm(fakeHome, { recursive: true, force: true });
    });

    // Real temporary files exercise the copy and publish behavior without a CLI launch.
    it('copies a save point with complete records and preserves the source files', async () => {
      const records = (sessionId: string) =>
        [
          { type: 'session.start', data: { sessionId } },
          { type: 'hook.start', data: { input: { sessionId } } },
          {
            type: 'session.usage_record',
            data: { usage: { accounting: { sourceSessionId: sessionId } } },
          },
          { type: 'system.message', data: { session_id: sessionId, content: parentId } },
          { type: 'user.message', data: { content: `Parent ID: ${parentId}` } },
          {
            type: 'tool.execution_start',
            data: { toolName: 'devchain_get_agent_by_name', arguments: { sessionId: parentId } },
          },
        ]
          .map((record) => JSON.stringify(record))
          .join('\n') + '\n';
      const partial = '{"type":"assistant.message"';
      const workspace = `id: "${parentId}"\ncwd: /project\nname: Parent\n`;
      await writeFile(input.transcriptPath, records(parentId) + partial);
      await writeFile(join(parentDir, 'workspace.yaml'), workspace);
      await mkdir(join(parentDir, 'files'));
      await writeFile(join(parentDir, 'files', 'context.txt'), 'context');

      const result = await adapter.createSavePoint(input);

      const savedDir = join(stateDir, savePointId);
      expect(result).toEqual({
        providerSessionId: savePointId,
        transcriptPath: join(savedDir, 'events.jsonl'),
        discardUnboundTranscript: expect.any(Function),
      });
      await expect(readFile(result.transcriptPath, 'utf8')).resolves.toBe(records(savePointId));
      expect(parse(await readFile(join(savedDir, 'workspace.yaml'), 'utf8'))).toEqual({
        id: savePointId,
        cwd: '/project',
        name: 'Parent',
      });
      await expect(readFile(join(savedDir, 'files', 'context.txt'), 'utf8')).resolves.toBe(
        'context',
      );
      await expect(readFile(input.transcriptPath, 'utf8')).resolves.toBe(
        records(parentId) + partial,
      );
      await expect(readFile(join(parentDir, 'workspace.yaml'), 'utf8')).resolves.toBe(workspace);
      await expect(readFile(join(parentDir, 'files', 'context.txt'), 'utf8')).resolves.toBe(
        'context',
      );

      // Discarding an unstored copy removes its folder and keeps the source.
      await result.discardUnboundTranscript!();
      await expect(readFile(join(savedDir, 'workspace.yaml'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(input.transcriptPath, 'utf8')).resolves.toBe(
        records(parentId) + partial,
      );
    });

    // The adapter output is the launch contract. A real transcript proves it points at the copy.
    it.each([
      ['-i "read the project notes"', ''],
      ['--interactive="read the project notes"', ''],
      ['-p"read the project notes"', ''],
      ['--prompt "read the project notes"', ''],
      ['-p "read the project notes" --attachment "screen shot.png"', ''],
      ['--prompt="read the project notes" --attachment="screen shot.png"', ''],
      ['-si "read the notes"', '-s'],
      ['-sp "read the notes"', '-s'],
      ['-si="read the notes"', '-s'],
      ['-sp"read the notes"', '-s'],
      ['-hsiprompt', '-hs'],
      ['-sniprompt', '-sniprompt'],
      ['-sZi "read the notes"', '-sZi "read the notes"'],
    ])(
      'filters %s from the child launch and can discard its unbound folder',
      async (flags, kept) => {
        await writeFile(
          input.transcriptPath,
          `{"type":"session.start","data":{"sessionId":"${parentId}"}}\n`,
        );
        await writeFile(join(parentDir, 'workspace.yaml'), `id: ${parentId}\n`);
        const savePoint = await adapter.createSavePoint(input);
        // The target row can own a session folder already, as for a rollback.
        const childEvents = `{"type":"session.start","data":{"sessionId":"${childId}"}}\n`;
        await mkdir(join(stateDir, childId));
        await writeFile(join(stateDir, childId, 'events.jsonl'), childEvents);

        const result = await adapter.prepareForkLaunch({
          ...input,
          ...savePoint,
          sessionId: childId,
          profileOptionArgs: parseProfileOptions(
            `--model x ${flags} --reasoning-effort=high --allow-all-tools`,
          ),
        });

        const copyId = result.providerSessionId;
        expect(copyId).not.toBe(childId);
        expect(result.argv).toEqual([
          `--resume=${copyId}`,
          '--model',
          'x',
          ...parseProfileOptions(kept),
          '--reasoning-effort=high',
          '--allow-all-tools',
        ]);
        expect(result.transcriptPath).toBe(join(stateDir, copyId, 'events.jsonl'));
        await expect(readFile(result.transcriptPath, 'utf8')).resolves.toContain(copyId);
        await expect(readFile(savePoint.transcriptPath, 'utf8')).resolves.toContain(savePointId);
        await result.discardUnboundTranscript?.();
        expect((await readdir(stateDir)).sort()).toEqual([parentId, savePointId, childId].sort());
        await expect(readdir(join(stateDir, childId))).resolves.toEqual(['events.jsonl']);
        await expect(readFile(join(stateDir, childId, 'events.jsonl'), 'utf8')).resolves.toBe(
          childEvents,
        );
      },
    );

    // A filesystem error proves a failed copy cannot publish a partial session.
    it('rejects a source with a missing transcript', async () => {
      await writeFile(join(parentDir, 'workspace.yaml'), `id: ${parentId}\n`);
      await expect(adapter.createSavePoint(input)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readdir(stateDir)).resolves.toEqual([parentId]);
    });

    // A real link tests whether the copied folder can still resolve mutable parent data.
    it.each(['save point', 'fork'] as const)(
      'rejects a companion symlink and removes the staging folder for a %s',
      async (operation) => {
        await writeFile(
          input.transcriptPath,
          `{"type":"session.start","data":{"sessionId":"${parentId}"}}\n`,
        );
        await writeFile(join(parentDir, 'workspace.yaml'), `id: ${parentId}\n`);
        const parentFile = join(parentDir, 'mutable.txt');
        const filesDir = join(parentDir, 'files');
        await writeFile(parentFile, 'parent data');
        await mkdir(filesDir);
        await symlink(parentFile, join(filesDir, 'linked.txt'));

        const copy =
          operation === 'save point'
            ? adapter.createSavePoint(input)
            : adapter.prepareForkLaunch({ ...input, sessionId: childId, profileOptionArgs: [] });

        await expect(copy).rejects.toThrow(
          'Copilot session folders with symbolic links cannot be copied',
        );
        await expect(readdir(stateDir)).resolves.toEqual([parentId]);
      },
    );

    // The filesystem must reject a rename over a populated directory and allow staging cleanup.
    it('removes the temporary folder when the destination already exists', async () => {
      await writeFile(
        input.transcriptPath,
        `{"type":"session.start","data":{"sessionId":"${parentId}"}}\n`,
      );
      await writeFile(join(parentDir, 'workspace.yaml'), `id: ${parentId}\n`);
      await adapter.createSavePoint(input);

      await expect(adapter.createSavePoint(input)).rejects.toThrow();
      expect((await readdir(stateDir)).sort()).toEqual([parentId, savePointId].sort());
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
      const withService = new CopilotAdapter(
        { ensure } as never,
        { isAuthenticated: jest.fn() } as never,
      );

      const result = await withService.provisionProjectPath('/home/user/project');

      expect(ensure).toHaveBeenCalledWith('/home/user/project');
      expect(result).toEqual({ success: true, warnings: [warning] });
    });

    it('never throws — a service failure becomes a provisioning warning', async () => {
      const ensure = jest.fn().mockRejectedValue(new Error('disk on fire'));
      const withService = new CopilotAdapter(
        { ensure } as never,
        { isAuthenticated: jest.fn() } as never,
      );

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

  // The adapter's argv is what both launch paths send to the CLI.
  it.each(['new', 'restore'] as const)('keeps the profile prompt and attachment for %s', (mode) => {
    const sessionId = 'sess-1';
    const profileOptionArgs = parseProfileOptions(
      '-p "read the project notes" --attachment "screen shot.png"',
    );

    const { argv } = adapter.buildLaunchArgs({
      mode,
      sessionId,
      providerSessionId: sessionId,
      profileOptionArgs,
    });

    const sessionArgs = mode === 'new' ? ['--session-id', sessionId] : [`--resume=${sessionId}`];
    expect(argv).toEqual([
      ...sessionArgs,
      '-p',
      'read the project notes',
      '--attachment',
      'screen shot.png',
    ]);
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
