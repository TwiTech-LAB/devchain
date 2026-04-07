/**
 * Tmux-backed integration tests for confirmed delivery.
 *
 * These tests run against a real tmux binary and verify that confirmation,
 * retry, and nonce detection work end-to-end with actual terminal sessions.
 *
 * Gated behind TMUX_INTEGRATION=1 environment variable.
 * Skipped (not failing) when the variable is unset.
 */

import { execSync } from 'child_process';
import { TmuxService } from './tmux.service';
import { EventsService } from '../../events/services/events.service';
import { generateDeliveryNonce } from '../../../common/delivery-nonce';

const TMUX_AVAILABLE = (() => {
  if (process.env.TMUX_INTEGRATION !== '1') return false;
  try {
    execSync('tmux -V', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const describeIf = TMUX_AVAILABLE ? describe : describe.skip;

describeIf('TmuxService confirmed delivery (tmux integration)', () => {
  let tmuxService: TmuxService;
  let eventsService: jest.Mocked<Partial<EventsService>>;
  let sessionName: string;

  beforeEach(async () => {
    eventsService = { publish: jest.fn() };
    tmuxService = new TmuxService(eventsService as EventsService);

    // Unique session name per test to avoid collisions
    sessionName = `devchain_inttest_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

    // Create a real tmux session running bash (echoes pasted input)
    await tmuxService.createSession(sessionName, '/tmp');
    // Brief settle to let bash initialize
    await new Promise((r) => setTimeout(r, 300));
  }, 10_000);

  afterEach(async () => {
    try {
      await tmuxService.destroySession(sessionName);
    } catch {
      // Session may already be gone
    }
  }, 10_000);

  it('confirms paste delivery when nonce appears in terminal output', async () => {
    const nonce = generateDeliveryNonce();
    const text = `echo "Hello world"\n[MsgId:${nonce}]`;

    // Paste with confirmation enabled
    await tmuxService.pasteAndSubmit(sessionName, text, {
      bracketed: true,
      submitKeys: ['Enter'],
      confirm: true,
      nonce,
    });

    // If we reach here, confirmation succeeded and Enter was sent.
    // Verify the nonce is in the captured pane output.
    const capture = await tmuxService.capturePaneStrict(sessionName, 20);
    expect(capture.ok).toBe(true);
    if (capture.ok) {
      expect(capture.output).toContain(nonce);
    }
  }, 30_000);

  it('confirmPasteDelivery times out when nonce was never pasted into session', async () => {
    // Search for a nonce that was never pasted — should time out
    const nonce = generateDeliveryNonce();

    const result = await tmuxService.confirmPasteDelivery(sessionName, nonce, {
      timeoutMs: 500,
      pollIntervalMs: 100,
      tailLines: 10,
    });

    expect(result.confirmed).toBe(false);
    expect(result.captureError).toBeUndefined();
    expect(result.elapsedMs).toBeGreaterThanOrEqual(400);
  }, 30_000);

  it('two consecutive deliveries have distinct nonces in terminal output', async () => {
    const nonce1 = generateDeliveryNonce();
    const nonce2 = generateDeliveryNonce();
    expect(nonce1).not.toBe(nonce2);

    // First delivery
    await tmuxService.pasteAndSubmit(sessionName, `msg1\n[MsgId:${nonce1}]`, {
      bracketed: true,
      submitKeys: ['Enter'],
      confirm: true,
      nonce: nonce1,
    });

    // Brief gap
    await new Promise((r) => setTimeout(r, 300));

    // Second delivery
    await tmuxService.pasteAndSubmit(sessionName, `msg2\n[MsgId:${nonce2}]`, {
      bracketed: true,
      submitKeys: ['Enter'],
      confirm: true,
      nonce: nonce2,
    });

    // Verify both nonces present in pane
    const capture = await tmuxService.capturePaneStrict(sessionName, 30);
    expect(capture.ok).toBe(true);
    if (capture.ok) {
      expect(capture.output).toContain(nonce1);
      expect(capture.output).toContain(nonce2);
    }
  }, 30_000);
});
