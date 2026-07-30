import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AppError } from '../../../../common/errors/error-types';
import { TerminalSessionRegistry } from '../terminal-session/terminal-session-registry';
import { TerminalIOService } from '../terminal-io/terminal-io.service';

/**
 * The only key shapes a mobile viewport key pad may send. Named navigation/confirm keys
 * travel as tmux key names; a single ASCII digit travels literally (for AskUserQuestion
 * numbered choices). Anything else is rejected — this is a hard trust boundary, so the
 * set is enumerated rather than derived from broader input-mapping tables.
 */
const NAMED_KEYS: ReadonlySet<string> = new Set([
  'Up',
  'Down',
  'Left',
  'Right',
  'Enter',
  'Escape',
  'Tab',
]);

const DIGIT_PATTERN = /^[0-9]$/;

/**
 * Minimum spacing between two accepted keys to the SAME session. Bounded input only — the
 * target is a single blocked prompt answered with a few discrete presses, not sustained
 * typing — so a small per-session gate is enough to blunt accidental bursts without
 * blocking normal use. Keyed by sessionId (never per-facade instance) below.
 */
const MIN_KEY_GAP_MS = 150;
const KEY_GAP_ENTRY_TTL_MS = 5 * 60 * 1000;

/**
 * Per-session "last accepted key" timestamps. Module-level (not per-facade-instance) so
 * the gate holds even if a future change ever constructed more than one facade: the rate
 * limit is a property of the session, not the DI holder.
 */
const lastAcceptedAtBySession = new Map<string, number>();

/**
 * Translate a whitelisted wire key into the exact `tmux send-keys` argv slice handed to
 * {@link TerminalIOService.sendControl}. Named keys pass straight through; a digit is sent
 * literally via `-l --` (no bracketed paste, no auto-Enter) so it selects a numbered TUI
 * choice without submitting. Throws `INVALID_KEY` for anything outside the whitelist.
 */
function toSendControlArgs(key: string): string[] {
  if (NAMED_KEYS.has(key)) return [key];
  if (DIGIT_PATTERN.test(key)) return ['-l', '--', key];
  throw new AppError('Key rejected by the mobile input whitelist.', 'INVALID_KEY', 400, { key });
}

/**
 * NARROW write facade exposing ONLY discrete mobile key input (`sendKey`). It is the sole
 * export of {@link TerminalKeyInputModule}, which `CloudTunnelModule` imports instead of
 * `TerminalModule` wholesale — keeping CloudTunnel a leaf/transitive consumer of the
 * Sessions↔Terminal SCC (see apps/local-app/scripts/cycle-allowlist.json). The
 * cloud-tunnel layer never injects `TerminalIOService` directly; it goes through this
 * facade.
 *
 * Unlike `control-keys.ts`, this whitelist does NOT fall back to passing unmapped input
 * through to tmux — at an RPC trust boundary that fallback is an injection hole, so every
 * accepted key is an explicit branch and everything else fails closed.
 */
@Injectable()
export class TerminalKeyInputFacade {
  constructor(
    private readonly registry: TerminalSessionRegistry,
    private readonly terminalIO: TerminalIOService,
  ) {}

  @OnEvent('session.stopped')
  handleSessionStopped(payload: { sessionId: string }): void {
    lastAcceptedAtBySession.delete(payload.sessionId);
  }

  @OnEvent('session.crashed')
  handleSessionCrashed(payload: { sessionId: string }): void {
    lastAcceptedAtBySession.delete(payload.sessionId);
  }

  /**
   * Send a single discrete key to the EXACT requested session.
   *
   * The session is resolved by sessionId (never agent-based), so a stale mobile view can
   * never key a different session. tmux liveness is re-checked before the key is sent and
   * `signalInput` runs after liveness passes (aligning the mobile press with the same
   * presence/activity tracking the desktop path uses). A per-session min-gap blunts bursts.
   *
   * Throws {@link AppError} with codes `RATE_LIMITED`, `INVALID_KEY`, or
   * `SESSION_NOT_RUNNING`; `toJsonRpcError` preserves each under `error.data.code`.
   */
  async sendKey(sessionId: string, key: string): Promise<{ ok: true }> {
    if (isWithinGap(sessionId)) {
      throw new AppError(
        'Too many keys sent to this session in quick succession.',
        'RATE_LIMITED',
        429,
        { sessionId },
      );
    }

    const keys = toSendControlArgs(key);

    const session = this.registry.get(sessionId);
    if (!session) {
      throw new AppError(
        'No running terminal session for this session id. Launch/restore it first.',
        'SESSION_NOT_RUNNING',
        409,
        { sessionId },
      );
    }

    const target = { name: session.tmuxSessionName };
    const alive = await this.terminalIO.sessionExists(target);
    if (!alive) {
      throw new AppError(
        'The tmux session backing this session is no longer running.',
        'SESSION_NOT_RUNNING',
        409,
        { sessionId },
      );
    }

    // Mirror the desktop input path (terminal.gateway.ts): signal activity AFTER the
    // liveness check and BEFORE the key is delivered, so a mobile press is tracked the
    // same way as a local keystroke.
    session.signalInput();
    await this.terminalIO.sendControl(target, keys);

    // Only an accepted key resets the gap window, so a rejected attempt cannot extend it.
    lastAcceptedAtBySession.set(sessionId, Date.now());
    return { ok: true };
  }
}

function isWithinGap(sessionId: string): boolean {
  const last = lastAcceptedAtBySession.get(sessionId);
  if (last === undefined) return false;
  const age = Date.now() - last;
  if (age >= KEY_GAP_ENTRY_TTL_MS) {
    lastAcceptedAtBySession.delete(sessionId);
    return false;
  }
  return age < MIN_KEY_GAP_MS;
}
