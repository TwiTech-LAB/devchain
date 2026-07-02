import { execFileSync } from 'child_process';
import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { CopilotHooksConfigService } from './copilot-hooks-config.service';
import { HookEventSchema } from '../dtos/hook-event.dto';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }),
}));

// Redirect os.homedir() to an isolated temp dir — NEVER touch the real ~/.copilot.
// os.homedir() ignores $HOME on this platform (getpwuid), so the module is mocked.
// A Proxy keeps every real os property/getter intact and overrides only homedir.
let mockHome = '';
jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'homedir') return () => mockHome;
      return target[prop];
    },
  });
});

describe('CopilotHooksConfigService', () => {
  let service: CopilotHooksConfigService;
  let fakeHome: string;

  beforeEach(async () => {
    service = new CopilotHooksConfigService();
    fakeHome = await mkdtemp(join(tmpdir(), 'copilot-hooks-home-'));
    mockHome = fakeHome;
  });

  afterEach(async () => {
    await rm(fakeHome, { recursive: true, force: true });
  });

  const hooksDir = () => join(fakeHome, '.copilot', 'hooks');
  const relayPath = () => join(hooksDir(), 'devchain-relay.sh');
  const configPath = () => join(hooksDir(), 'devchain.json');

  describe('static identity', () => {
    it('exposes the copilot provider name (used for installer dispatch)', () => {
      expect(service.providerName).toBe('copilot');
    });
  });

  describe('ensureHooksConfig — file materialization', () => {
    it('writes an executable relay script at ~/.copilot/hooks/devchain-relay.sh', async () => {
      await service.ensureHooksConfig('/some/project');

      const script = await readFile(relayPath(), 'utf-8');
      expect(script).toContain('#!/bin/bash');
      expect(script).toContain('DEVCHAIN_API_URL');
      expect(script).toContain('curl');
      expect(script).toContain('/api/hooks/events');

      const mode = (await stat(relayPath())).mode & 0o777;
      expect(mode & 0o111).toBeTruthy(); // executable bits set
    });

    it('writes a copilot-shaped hook config (version + bash + timeoutSec, PascalCase keys)', async () => {
      await service.ensureHooksConfig('/some/project');

      const config = JSON.parse(await readFile(configPath(), 'utf-8'));
      expect(config.version).toBe(1);

      // Copilot schema differs from Claude: `bash` (not `command`) + `timeoutSec`.
      expect(config.hooks.SessionStart).toHaveLength(1);
      expect(config.hooks.SessionStart[0].type).toBe('command');
      expect(config.hooks.SessionStart[0].timeoutSec).toBe(10);
      expect(config.hooks.SessionStart[0]).not.toHaveProperty('command');
      expect(config.hooks.SessionStart[0]).not.toHaveProperty('timeout');

      expect(config.hooks.Stop).toHaveLength(1);
      expect(config.hooks.Stop[0].type).toBe('command');
      expect(config.hooks.Stop[0].timeoutSec).toBe(10);
    });

    it('passes the PascalCase event name as the relay arg, with the path quoted', async () => {
      await service.ensureHooksConfig('/some/project');

      const config = JSON.parse(await readFile(configPath(), 'utf-8'));
      const quoted = `"${relayPath()}"`;
      expect(config.hooks.SessionStart[0].bash).toBe(`${quoted} SessionStart`);
      expect(config.hooks.Stop[0].bash).toBe(`${quoted} Stop`);
    });

    it('is idempotent — calling twice yields a single config + relay (overwrite)', async () => {
      await service.ensureHooksConfig('/p');
      await service.ensureHooksConfig('/p');

      const config = JSON.parse(await readFile(configPath(), 'utf-8'));
      expect(config.hooks.SessionStart).toHaveLength(1);
      expect(config.hooks.Stop).toHaveLength(1);
    });

    it('never throws — a write failure is swallowed (non-fatal)', async () => {
      // Force homedir() to a path that cannot be created (a file, not a dir).
      mockHome = '/dev/null';
      await expect(service.ensureHooksConfig('/p')).resolves.toBeUndefined();
    });
  });

  describe('relay script — blast-radius guard + snake_case→DTO normalization', () => {
    /**
     * Materialize the real relay, then run it through bash with a stubbed `curl`
     * (captures the POST body) and a mock copilot hook payload on stdin. Returns
     * `undefined` (no POST captured) when the relay no-ops, or the parsed payload.
     * Returns `null` when jq/bash is unavailable on the host.
     */
    function runRelay(
      eventArg: string,
      hookJson: unknown,
      env: Record<string, string>,
    ): Record<string, unknown> | null | undefined {
      let bashOk = true;
      try {
        execFileSync('bash', ['-c', 'command -v jq >/dev/null && command -v bash >/dev/null']);
      } catch {
        bashOk = false;
      }
      if (!bashOk) return null;

      const binDir = join(fakeHome, 'fakebin');
      const captureFile = join(fakeHome, 'captured-payload.json');

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
      execFileSync('rm', ['-f', captureFile]);
      execFileSync('bash', [
        '-c',
        `cat > "${join(binDir, 'curl')}" <<'EOF'\n${fakeCurl}EOF\nchmod +x "${join(binDir, 'curl')}"`,
      ]);

      // Strip any inherited DEVCHAIN_* vars (this test harness itself runs inside a
      // devchain session) so each case fully controls the blast-radius guard inputs.
      const baseEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (k.startsWith('DEVCHAIN_') || v === undefined) continue;
        baseEnv[k] = v;
      }

      // Never let a subprocess failure propagate as a (circular) ExecException —
      // the relay is fail-open (exit 0) anyway, so a throw here is a test bug.
      try {
        execFileSync('bash', [relayPath(), eventArg], {
          input: JSON.stringify(hookJson),
          env: { ...baseEnv, PATH: `${binDir}:${process.env.PATH ?? ''}`, ...env },
        });
      } catch (err) {
        throw new Error(`relay subprocess failed: ${(err as Error).message}`);
      }

      const raw = execFileSync('bash', ['-c', `cat "${captureFile}" 2>/dev/null || true`])
        .toString()
        .trim();
      if (raw.length === 0) return undefined;
      return JSON.parse(raw) as Record<string, unknown>;
    }

    const DEVCHAIN_ENV = {
      DEVCHAIN_API_URL: 'http://localhost:9999',
      DEVCHAIN_TMUX_SESSION_NAME: 'devchain-test',
      DEVCHAIN_PROJECT_ID: '11111111-1111-1111-1111-111111111111',
      DEVCHAIN_AGENT_ID: '22222222-2222-2222-2222-222222222222',
      DEVCHAIN_SESSION_ID: '33333333-3333-3333-3333-333333333333',
    };

    it('NO-OPS (no POST) when DEVCHAIN_API_URL is absent — blast-radius guard', async () => {
      await service.ensureHooksConfig('/p');
      const result = runRelay(
        'SessionStart',
        { session_id: 'cp-1', source: 'new' },
        { DEVCHAIN_SESSION_ID: '33333333-3333-3333-3333-333333333333' }, // no API URL
      );
      if (result === null) return; // jq/bash unavailable
      expect(result).toBeUndefined();
    });

    it('NO-OPS (no POST) when DEVCHAIN_SESSION_ID is absent — blast-radius guard', async () => {
      await service.ensureHooksConfig('/p');
      const result = runRelay(
        'SessionStart',
        { session_id: 'cp-1', source: 'new' },
        { DEVCHAIN_API_URL: 'http://localhost:9999', DEVCHAIN_TMUX_SESSION_NAME: 'x' }, // no SESSION_ID
      );
      if (result === null) return;
      expect(result).toBeUndefined();
    });

    it('normalizes a SessionStart payload (session_id→providerSessionId, providerName=copilot)', async () => {
      await service.ensureHooksConfig('/p');
      const payload = runRelay(
        'SessionStart',
        { session_id: 'cp-session-1', source: 'new', model: 'claude-sonnet-4.5' },
        DEVCHAIN_ENV,
      );
      if (payload === null || payload === undefined) return;

      expect(payload.hookEventName).toBe('SessionStart');
      expect(payload.providerName).toBe('copilot');
      expect(payload.providerSessionId).toBe('cp-session-1');
      expect(payload.source).toBe('new');
      expect(payload.model).toBe('claude-sonnet-4.5');
      expect(payload.sessionId).toBe('33333333-3333-3333-3333-333333333333');
      expect(payload.projectId).toBe('11111111-1111-1111-1111-111111111111');
      expect(payload.tmuxSessionName).toBe('devchain-test');
      // Stop-only field absent on SessionStart (kept strict-clean).
      expect('stopReason' in payload).toBe(false);
      // End-to-end: the normalized payload satisfies the real P3-2 DTO (.strict()).
      expect(() => HookEventSchema.parse(payload)).not.toThrow();
    });

    it('defaults a missing SessionStart source to "startup" (DTO requires it)', async () => {
      await service.ensureHooksConfig('/p');
      const payload = runRelay('SessionStart', { session_id: 'cp-1' }, DEVCHAIN_ENV);
      if (payload === null || payload === undefined) return;
      expect(payload.source).toBe('startup');
    });

    it('normalizes a Stop payload (transcript_path→transcriptPath, stop_reason→stopReason)', async () => {
      await service.ensureHooksConfig('/p');
      const payload = runRelay(
        'Stop',
        { session_id: 'cp-2', transcript_path: '/t/x.jsonl', stop_reason: 'end_turn' },
        DEVCHAIN_ENV,
      );
      if (payload === null || payload === undefined) return;

      expect(payload.hookEventName).toBe('Stop');
      expect(payload.providerName).toBe('copilot');
      expect(payload.providerSessionId).toBe('cp-2');
      expect(payload.transcriptPath).toBe('/t/x.jsonl');
      expect(payload.stopReason).toBe('end_turn');
      // SessionStart-only field absent on Stop (kept strict-clean).
      expect('source' in payload).toBe(false);
      // End-to-end: the normalized payload satisfies the real P3-2 DTO (.strict()).
      expect(() => HookEventSchema.parse(payload)).not.toThrow();
    });

    it('NO-OPS for an unrecognized event arg', async () => {
      await service.ensureHooksConfig('/p');
      const result = runRelay('NotAHook', { session_id: 'cp-1' }, DEVCHAIN_ENV);
      if (result === null) return;
      expect(result).toBeUndefined();
    });
  });

  describe('relay script — fail-open hardening (Code Review)', () => {
    const DEVCHAIN_ENV = {
      DEVCHAIN_API_URL: 'http://localhost:9999',
      DEVCHAIN_TMUX_SESSION_NAME: 'devchain-test',
      DEVCHAIN_PROJECT_ID: '11111111-1111-1111-1111-111111111111',
      DEVCHAIN_AGENT_ID: '22222222-2222-2222-2222-222222222222',
      DEVCHAIN_SESSION_ID: '33333333-3333-3333-3333-333333333333',
    };

    // Host must have jq+bash for these to be meaningful (the relay strips jq via a
    // restricted PATH, so the HOST needs jq to prove the contrast). Skip otherwise.
    function hostHasTools(): boolean {
      try {
        execFileSync('bash', ['-c', 'command -v jq >/dev/null && command -v curl >/dev/null']);
        return true;
      } catch {
        return false;
      }
    }

    /**
     * Materialize + run the real relay with RAW stdin (so we can feed malformed
     * JSON) and a controllable PATH (so we can hide jq). The relay is fail-open, so
     * a NON-ZERO exit is the bug we're guarding against — re-thrown as a clean
     * (non-circular) error to fail the test. Returns whether a POST was captured.
     */
    function runRaw(
      eventArg: string,
      rawStdin: string,
      opts: { stripJq?: boolean } = {},
    ): { posted: boolean } {
      const binDir = join(fakeHome, 'failopen-bin');
      const captureFile = join(fakeHome, 'failopen-captured.json');
      execFileSync('mkdir', ['-p', binDir]);
      execFileSync('rm', ['-f', captureFile]);

      const fakeCurl = `#!/bin/bash
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-d" ]; then shift; out="$1"; fi
  shift
done
printf '%s' "$out" > "${captureFile}"
exit 0
`;
      execFileSync('bash', [
        '-c',
        `cat > "${join(binDir, 'curl')}" <<'EOF'\n${fakeCurl}EOF\nchmod +x "${join(binDir, 'curl')}"`,
      ]);

      // Symlink bash into the restricted dir so execFileSync can still resolve the
      // interpreter when PATH is narrowed to ONLY this dir (the stripJq case);
      // otherwise the relay can't be spawned at all (ENOENT) and we'd never reach
      // the in-script `command -v jq` guard we're trying to exercise.
      execFileSync('bash', ['-c', `ln -sf "$(command -v bash)" "${join(binDir, 'bash')}"`]);

      const baseEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (k.startsWith('DEVCHAIN_') || v === undefined) continue;
        baseEnv[k] = v;
      }

      // stripJq → PATH is ONLY the fake-curl dir, so `command -v jq` fails and the
      // relay must no-op at the tooling guard. Otherwise jq resolves normally.
      const PATH = opts.stripJq ? binDir : `${binDir}:${process.env.PATH ?? ''}`;

      try {
        execFileSync('bash', [relayPath(), eventArg], {
          input: rawStdin,
          env: { ...baseEnv, PATH, ...DEVCHAIN_ENV },
        });
      } catch (err) {
        throw new Error(`relay was NOT fail-open (non-zero exit): ${(err as Error).message}`);
      }

      const raw = execFileSync('bash', ['-c', `cat "${captureFile}" 2>/dev/null || true`])
        .toString()
        .trim();
      return { posted: raw.length > 0 };
    }

    it('exits 0 and does NOT POST on malformed stdin JSON', async () => {
      if (!hostHasTools()) return;
      await service.ensureHooksConfig('/p');
      const { posted } = runRaw('SessionStart', '{ this is : not valid json ]');
      expect(posted).toBe(false);
    });

    it('exits 0 and does NOT POST when jq is unavailable (restricted PATH)', async () => {
      if (!hostHasTools()) return;
      await service.ensureHooksConfig('/p');
      const { posted } = runRaw(
        'SessionStart',
        JSON.stringify({ session_id: 'cp-1', source: 'new' }),
        { stripJq: true },
      );
      expect(posted).toBe(false);
    });

    it('still POSTs for a well-formed payload (fail-open guards did not over-block)', async () => {
      if (!hostHasTools()) return;
      await service.ensureHooksConfig('/p');
      const { posted } = runRaw(
        'SessionStart',
        JSON.stringify({ session_id: 'cp-ok', source: 'new' }),
      );
      expect(posted).toBe(true);
    });
  });
});
