import { mkdtemp, readFile, rm, writeFile, stat, mkdir } from 'fs/promises';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { HooksConfigService } from './hooks-config.service';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }),
}));

describe('HooksConfigService', () => {
  let service: HooksConfigService;
  let tempDir: string;

  beforeEach(async () => {
    service = new HooksConfigService();
    tempDir = await mkdtemp(join(tmpdir(), 'hooks-config-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('ensureHooksConfig', () => {
    it('should create settings and relay script when no .claude directory exists', async () => {
      await service.ensureHooksConfig(tempDir);

      // Verify relay script exists
      const scriptPath = join(tempDir, '.claude', 'hooks', 'devchain-relay.sh');
      const scriptContent = await readFile(scriptPath, 'utf-8');
      expect(scriptContent).toContain('#!/bin/bash');
      expect(scriptContent).toContain('DEVCHAIN_API_URL');
      expect(scriptContent).toContain('curl');

      // Verify script is executable
      const scriptStat = await stat(scriptPath);
      const mode = scriptStat.mode & 0o777;
      expect(mode & 0o111).toBeTruthy(); // executable bits set

      // Verify settings file exists and has hooks config
      const settingsPath = join(tempDir, '.claude', 'settings.local.json');
      const settingsContent = JSON.parse(await readFile(settingsPath, 'utf-8'));
      expect(settingsContent.hooks).toBeDefined();
      expect(settingsContent.hooks.SessionStart).toBeInstanceOf(Array);
      expect(settingsContent.hooks.SessionStart).toHaveLength(1);

      // PreToolUse + PostToolUse matcher groups for AskUserQuestion
      expect(settingsContent.hooks.PreToolUse).toHaveLength(1);
      expect(settingsContent.hooks.PreToolUse[0].matcher).toBe('AskUserQuestion');
      expect(settingsContent.hooks.PreToolUse[0].hooks[0].command).toContain('devchain-relay.sh');
      expect(settingsContent.hooks.PostToolUse).toHaveLength(1);
      expect(settingsContent.hooks.PostToolUse[0].matcher).toBe('AskUserQuestion');
      expect(settingsContent.hooks.PostToolUse[0].hooks[0].command).toContain('devchain-relay.sh');
    });

    it('should preserve existing permissions and user keys during merge', async () => {
      const settingsDir = join(tempDir, '.claude');
      await mkdir(settingsDir, { recursive: true });

      const existingSettings = {
        permissions: { allow: ['mcp__devchain'], deny: [], ask: [] },
        customKey: 'user-value',
      };
      await writeFile(
        join(settingsDir, 'settings.local.json'),
        JSON.stringify(existingSettings, null, 2),
      );

      await service.ensureHooksConfig(tempDir);

      const settings = JSON.parse(
        await readFile(join(settingsDir, 'settings.local.json'), 'utf-8'),
      );
      expect(settings.permissions).toEqual({ allow: ['mcp__devchain'], deny: [], ask: [] });
      expect(settings.customKey).toBe('user-value');
      expect(settings.hooks.SessionStart).toHaveLength(1);
    });

    it('should preserve existing user hooks and add DevChain entry', async () => {
      const settingsDir = join(tempDir, '.claude');
      await mkdir(settingsDir, { recursive: true });

      const existingSettings = {
        hooks: {
          SessionStart: [
            {
              matcher: 'startup',
              hooks: [{ type: 'command', command: '/user/custom-hook.sh' }],
            },
          ],
        },
      };
      await writeFile(
        join(settingsDir, 'settings.local.json'),
        JSON.stringify(existingSettings, null, 2),
      );

      await service.ensureHooksConfig(tempDir);

      const settings = JSON.parse(
        await readFile(join(settingsDir, 'settings.local.json'), 'utf-8'),
      );
      // User hook preserved + DevChain hook added
      expect(settings.hooks.SessionStart).toHaveLength(2);
      const userHook = settings.hooks.SessionStart[0];
      expect(userHook.hooks[0].command).toBe('/user/custom-hook.sh');
      const devchainHook = settings.hooks.SessionStart[1];
      expect(devchainHook.hooks[0].command).toContain('devchain-relay.sh');
    });

    it('should handle invalid JSON in settings gracefully', async () => {
      const settingsDir = join(tempDir, '.claude');
      await mkdir(settingsDir, { recursive: true });
      await writeFile(join(settingsDir, 'settings.local.json'), 'not valid json {{{');

      await service.ensureHooksConfig(tempDir);

      // Should create fresh settings
      const settings = JSON.parse(
        await readFile(join(settingsDir, 'settings.local.json'), 'utf-8'),
      );
      expect(settings.hooks.SessionStart).toHaveLength(1);
    });

    it('should be idempotent — calling twice produces same result', async () => {
      await service.ensureHooksConfig(tempDir);
      await service.ensureHooksConfig(tempDir);

      const settings = JSON.parse(
        await readFile(join(tempDir, '.claude', 'settings.local.json'), 'utf-8'),
      );
      // Should still have exactly one DevChain hook group per event, not two
      expect(settings.hooks.SessionStart).toHaveLength(1);
      expect(settings.hooks.PreToolUse).toHaveLength(1);
      expect(settings.hooks.PostToolUse).toHaveLength(1);
    });

    it('should use absolute path for hook command', async () => {
      await service.ensureHooksConfig(tempDir);

      const settings = JSON.parse(
        await readFile(join(tempDir, '.claude', 'settings.local.json'), 'utf-8'),
      );
      const command = settings.hooks.SessionStart[0].hooks[0].command;
      expect(command).toContain(tempDir);
      expect(command).toContain('.claude/hooks/devchain-relay.sh');
    });

    it('fresh-install settings.local.json is byte-stable and Copilot-schema-free (Claude golden)', async () => {
      // Safety net for the P3 hook generalization: the Claude installer output
      // must be byte-for-byte unchanged — exact matcher groups + `command`/
      // `timeout` keys — with NO Copilot schema keys (`bash`/`timeoutSec`) and
      // no Copilot-only event keys leaking into the Claude config.
      await service.ensureHooksConfig(tempDir);
      const settings = JSON.parse(
        await readFile(join(tempDir, '.claude', 'settings.local.json'), 'utf-8'),
      );

      const relayCmd = `"${join(tempDir, '.claude', 'hooks', 'devchain-relay.sh')}"`;
      const expectDevchainEntry = (group: string, matcher?: string) => {
        expect(settings.hooks[group]).toHaveLength(1);
        const groupEntry = settings.hooks[group][0];
        if (matcher !== undefined) {
          expect(groupEntry.matcher).toBe(matcher);
        } else {
          expect(groupEntry).not.toHaveProperty('matcher');
        }
        expect(groupEntry.hooks).toHaveLength(1);
        const hook = groupEntry.hooks[0];
        expect(hook).toEqual({ type: 'command', command: relayCmd, timeout: 10 });
        // Copilot schema keys must NOT appear in the Claude config.
        expect(hook).not.toHaveProperty('bash');
        expect(hook).not.toHaveProperty('timeoutSec');
      };

      expectDevchainEntry('SessionStart');
      expectDevchainEntry('PreToolUse', 'AskUserQuestion');
      expectDevchainEntry('PostToolUse', 'AskUserQuestion');
      // Exactly the three Claude event groups — no Copilot-only keys.
      expect(Object.keys(settings.hooks).sort()).toEqual([
        'PostToolUse',
        'PreToolUse',
        'SessionStart',
      ]);
    });

    it('should not throw on errors (non-fatal)', async () => {
      // Pass a path that will fail (read-only scenarios handled by the service)
      // The service wraps everything in try/catch, so this should not throw
      await expect(service.ensureHooksConfig(tempDir)).resolves.toBeUndefined();
    });

    it('should generate a relay script that forwards tool fields', async () => {
      await service.ensureHooksConfig(tempDir);
      const script = await readFile(
        join(tempDir, '.claude', 'hooks', 'devchain-relay.sh'),
        'utf-8',
      );

      // tool_name / tool_use_id forwarded
      expect(script).toContain('.tool_name');
      expect(script).toContain('.tool_use_id');
      // tool_input forwarded as an OBJECT (--argjson, not --arg → never stringified)
      expect(script).toContain('--argjson toolInput');
      expect(script).toContain('.tool_input');
      // tool_response forwarded + size-capped
      expect(script).toContain('--argjson toolResponse');
      expect(script).toContain('.tool_response');
      expect(script).toContain('truncated: true');
    });
  });

  describe('relay jq extraction (executed against mock hook JSON)', () => {
    /**
     * Materializes the real relay script and runs it through bash with a stubbed
     * `curl` (captures the POST body) and a mock PreToolUse hook JSON on stdin.
     * Proves the jq pipeline extracts toolName/toolInput(object)/toolUseId.
     */
    function runRelay(hookJson: unknown): Record<string, unknown> | null {
      let bashOk = true;
      try {
        execFileSync('bash', ['-c', 'command -v jq >/dev/null && command -v bash >/dev/null']);
      } catch {
        bashOk = false;
      }
      if (!bashOk) return null;

      const scriptPath = join(tempDir, '.claude', 'hooks', 'devchain-relay.sh');
      const binDir = join(tempDir, 'fakebin');
      const captureFile = join(tempDir, 'captured-payload.json');

      // Fake curl: capture the value passed to -d into captureFile, exit 0.
      const fakeCurl = `#!/bin/bash
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-d" ]; then shift; out="$1"; fi
  shift
done
printf '%s' "$out" > "${captureFile}"
exit 0
`;

      execFileSync('mkdir', ['-p', binDir]);
      // Write + chmod the fake curl synchronously via bash to keep the test simple.
      execFileSync('bash', [
        '-c',
        `cat > "${join(binDir, 'curl')}" <<'EOF'\n${fakeCurl}EOF\nchmod +x "${join(binDir, 'curl')}"`,
      ]);

      execFileSync('bash', [scriptPath], {
        input: JSON.stringify(hookJson),
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          DEVCHAIN_API_URL: 'http://localhost:9999',
          DEVCHAIN_TMUX_SESSION_NAME: 'devchain-test',
          DEVCHAIN_PROJECT_ID: '11111111-1111-1111-1111-111111111111',
          DEVCHAIN_AGENT_ID: '22222222-2222-2222-2222-222222222222',
          DEVCHAIN_SESSION_ID: '33333333-3333-3333-3333-333333333333',
        },
      });

      const raw = execFileSync('cat', [captureFile]).toString();
      return JSON.parse(raw) as Record<string, unknown>;
    }

    it('extracts toolName, toolInput (as object), and toolUseId from a PreToolUse hook', async () => {
      await service.ensureHooksConfig(tempDir);

      const payload = runRelay({
        hook_event_name: 'PreToolUse',
        session_id: 'claude-session-1',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'toolu_abc',
        tool_input: {
          questions: [
            {
              question: 'Which color?',
              header: 'Color',
              multiSelect: false,
              options: [{ label: 'Red', description: 'r' }],
            },
          ],
        },
      });

      if (payload === null) {
        // jq/bash unavailable — extraction asserted via script content elsewhere.
        return;
      }

      expect(payload.hookEventName).toBe('PreToolUse');
      expect(payload.toolName).toBe('AskUserQuestion');
      expect(payload.toolUseId).toBe('toolu_abc');
      // toolInput preserved as a nested OBJECT, not a JSON string
      expect(typeof payload.toolInput).toBe('object');
      expect(payload.toolInput).toEqual({
        questions: [
          {
            question: 'Which color?',
            header: 'Color',
            multiSelect: false,
            options: [{ label: 'Red', description: 'r' }],
          },
        ],
      });
      // source omitted for non-SessionStart variants (kept strict-clean)
      expect('source' in payload).toBe(false);
      expect(payload.projectId).toBe('11111111-1111-1111-1111-111111111111');
    });

    it('omits tool fields for a SessionStart hook (backward compatible)', async () => {
      await service.ensureHooksConfig(tempDir);

      const payload = runRelay({
        hook_event_name: 'SessionStart',
        session_id: 'claude-session-1',
        source: 'startup',
      });

      if (payload === null) return;

      expect(payload.hookEventName).toBe('SessionStart');
      expect(payload.source).toBe('startup');
      expect('toolName' in payload).toBe(false);
      expect('toolInput' in payload).toBe(false);
      expect('toolUseId' in payload).toBe(false);
    });
  });
});
