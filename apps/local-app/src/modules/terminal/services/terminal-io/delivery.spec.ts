import { TerminalIOService } from './terminal-io.service';
import { FakeProcessExecutor } from '../process-executor/fake-process-executor';
import type { SessionTarget, DeliveryOptions } from './types';

jest.mock('../../../../common/delivery-nonce', () => ({
  generateDeliveryNonce: () => 'abc1234',
}));

const target: SessionTarget = { name: 'test-session' };
const NONCE = 'abc1234';

function makeService() {
  const fake = new FakeProcessExecutor();
  const svc = new TerminalIOService(fake);
  return { fake, svc };
}

describe('TerminalIOService delivery', () => {
  describe('deliver', () => {
    it('sends bracketed-paste via load-buffer + paste-buffer argv sequence', async () => {
      const { fake, svc } = makeService();
      // captureStrict baseline
      fake.enqueueResponse({ type: 'success', stdout: '' });
      // load-buffer
      fake.enqueueResponse({ type: 'success' });
      // paste-buffer
      fake.enqueueResponse({ type: 'success' });
      // delete-buffer
      fake.enqueueResponse({ type: 'success' });
      // confirmPasteDelivery poll — nonce found
      fake.enqueueResponse({
        type: 'success',
        stdout: `some output [MsgId:${NONCE}]`,
      });
      // send-keys (Enter)
      fake.enqueueResponse({ type: 'success' });

      const opts: DeliveryOptions = { agentId: 'agent-1', confirm: true };
      const result = await svc.deliver(target, 'hello', opts);

      expect(result.confirmed).toBe(true);
      expect(result.retryCount).toBe(0);

      const loadBufferCall = fake.calls.find((c) => c.argv[1] === 'load-buffer');
      expect(loadBufferCall).toBeDefined();
      expect(loadBufferCall!.argv).toContain('-b');
      expect(loadBufferCall!.argv).toContain('-');

      const pasteBufferCall = fake.calls.find((c) => c.argv[1] === 'paste-buffer');
      expect(pasteBufferCall).toBeDefined();
      expect(pasteBufferCall!.argv).toContain('-b');
      expect(pasteBufferCall!.argv).toContain('test-session');

      const sendKeysCall = fake.calls.find((c) => c.argv[1] === 'send-keys');
      expect(sendKeysCall).toBeDefined();
      expect(sendKeysCall!.argv).toContain('Enter');
    });

    it('3-tier confirmation: nonce found returns nonce method', async () => {
      const { fake, svc } = makeService();
      // baseline
      fake.enqueueResponse({ type: 'success', stdout: 'baseline' });
      // load-buffer, paste-buffer, delete-buffer
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      // confirmation poll — nonce found
      fake.enqueueResponse({
        type: 'success',
        stdout: `output [MsgId:${NONCE}]`,
      });
      // send-keys
      fake.enqueueResponse({ type: 'success' });

      const result = await svc.deliver(target, 'msg', {
        agentId: 'a1',
        confirm: true,
      });

      expect(result.confirmed).toBe(true);
      expect(result.method).toBe('nonce');
    });

    it('confirmed-path retry success: first sendKeys fails, second succeeds', async () => {
      const { fake, svc } = makeService();
      fake.enqueueResponse({ type: 'success', stdout: '' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success', stdout: `[MsgId:${NONCE}]` });
      // submit-key first attempt fails
      fake.enqueueResponse({ type: 'failure', stderr: 'transient' });
      // submit-key retry succeeds
      fake.enqueueResponse({ type: 'success' });

      const result = await svc.deliver(target, 'msg', { agentId: 'a1', confirm: true });

      expect(result.confirmed).toBe(true);
      expect(result.method).toBe('nonce');
      const submitCalls = fake.calls.filter((c) => c.argv[1] === 'send-keys');
      expect(submitCalls).toHaveLength(2);
    });

    it('confirmed-path double-failure: both submit-key sends throw', async () => {
      const { fake, svc } = makeService();
      fake.enqueueResponse({ type: 'success', stdout: '' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success', stdout: `[MsgId:${NONCE}]` });
      // both submit-key attempts fail
      fake.enqueueResponse({ type: 'failure', stderr: 'fail1' });
      fake.enqueueResponse({ type: 'failure', stderr: 'fail2' });

      await expect(svc.deliver(target, 'msg', { agentId: 'a1', confirm: true })).rejects.toThrow(
        /Failed to send keys/,
      );
    });

    it('unconfirmed-path retry success: first submit fails, second succeeds', async () => {
      const { fake, svc } = makeService();
      // load-buffer, paste-buffer, delete-buffer (confirm:false skips baseline capture)
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      // submit-key first attempt fails
      fake.enqueueResponse({ type: 'failure', stderr: 'transient' });
      // submit-key retry succeeds
      fake.enqueueResponse({ type: 'success' });

      const result = await svc.deliver(target, 'msg', {
        agentId: 'a1',
        confirm: false,
        postPasteDelayMs: 0,
      });

      expect(result.confirmed).toBe(true);
      const submitCalls = fake.calls.filter((c) => c.argv[1] === 'send-keys');
      expect(submitCalls).toHaveLength(2);
    });

    it('pre-keys fail-fast: no retry on pre-key send failure', async () => {
      const { fake, svc } = makeService();
      // pre-key send fails immediately
      fake.enqueueResponse({ type: 'failure', stderr: 'session gone' });

      await expect(
        svc.deliver(target, 'msg', { agentId: 'a1', preKeys: ['Escape'] }),
      ).rejects.toThrow(/Failed to send keys/);

      // Only 1 call — no retry for pre-keys
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0].argv).toContain('Escape');
    });

    it('no submit keys: helper is no-op when submitKeys is empty', async () => {
      const { fake, svc } = makeService();
      fake.enqueueResponse({ type: 'success', stdout: '' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success', stdout: `[MsgId:${NONCE}]` });

      const result = await svc.deliver(target, 'msg', {
        agentId: 'a1',
        confirm: true,
        submitKeys: [],
      });

      expect(result.confirmed).toBe(true);
      const submitCalls = fake.calls.filter((c) => c.argv[1] === 'send-keys');
      expect(submitCalls).toHaveLength(0);
    });

    it('3-tier confirmation: paste_indicator fallback', async () => {
      const { fake, svc } = makeService();
      // baseline — no paste indicator
      fake.enqueueResponse({ type: 'success', stdout: 'baseline text' });
      // load-buffer, paste-buffer, delete-buffer
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      // confirmation poll — no nonce, but new paste indicator line
      fake.enqueueResponse({
        type: 'success',
        stdout: 'baseline text\nContent pasted successfully',
      });
      // send-keys
      fake.enqueueResponse({ type: 'success' });

      const result = await svc.deliver(target, 'msg', {
        agentId: 'a1',
        confirm: true,
      });

      expect(result.confirmed).toBe(true);
      expect(result.method).toBe('paste_indicator');
    });

    it('retries on paste-not-confirmed and sends Escape between attempts', async () => {
      const { fake, svc } = makeService();

      // Attempt 1: baseline + load + paste + delete
      fake.enqueueResponse({ type: 'success', stdout: '' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      // confirm polls: ~2 polls before 50ms timeout (poll at 0ms, sleep 150ms, poll at ~150ms > 50ms)
      fake.enqueueResponse({ type: 'success', stdout: 'no match' });
      fake.enqueueResponse({ type: 'success', stdout: 'no match' });
      // Escape key after failed attempt
      fake.enqueueResponse({ type: 'success' });
      // Attempt 2: baseline + load + paste + delete
      fake.enqueueResponse({ type: 'success', stdout: '' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      // confirm → nonce found immediately
      fake.enqueueResponse({
        type: 'success',
        stdout: `found [MsgId:${NONCE}]`,
      });
      // send-keys (Enter)
      fake.enqueueResponse({ type: 'success' });

      const result = await svc.deliver(target, 'msg', {
        agentId: 'a1',
        confirm: true,
        confirmTimeoutMs: 50,
        maxAttempts: 2,
      });

      expect(result.retryCount).toBe(1);
      expect(result.confirmed).toBe(true);

      const escapeCalls = fake.calls.filter(
        (c) => c.argv[1] === 'send-keys' && c.argv.includes('Escape'),
      );
      expect(escapeCalls.length).toBeGreaterThanOrEqual(1);
    }, 15000);

    it('returns unconfirmed after exhausting max attempts', async () => {
      const { fake, svc } = makeService();

      for (let attempt = 0; attempt < 2; attempt++) {
        // baseline + load + paste + delete
        fake.enqueueResponse({ type: 'success', stdout: '' });
        fake.enqueueResponse({ type: 'success' });
        fake.enqueueResponse({ type: 'success' });
        fake.enqueueResponse({ type: 'success' });
        // 2 confirm polls before timeout
        fake.enqueueResponse({ type: 'success', stdout: 'nope' });
        fake.enqueueResponse({ type: 'success', stdout: 'nope' });
        if (attempt < 1) {
          fake.enqueueResponse({ type: 'success' }); // Escape
        }
      }
      // Fallback Enter
      fake.enqueueResponse({ type: 'success' });

      const result = await svc.deliver(target, 'msg', {
        agentId: 'a1',
        confirm: true,
        confirmTimeoutMs: 50,
        maxAttempts: 2,
      });

      expect(result.confirmed).toBe(false);
      expect(result.retryCount).toBe(1);
    }, 15000);

    it('pre-keys fail-fast: no retry on pre-key failure', async () => {
      const { fake, svc } = makeService();
      // send-keys (pre-key) fails
      fake.enqueueResponse({ type: 'failure', stderr: 'session not found' });

      await expect(
        svc.deliver(target, 'msg', {
          agentId: 'a1',
          preKeys: ['Escape'],
        }),
      ).rejects.toThrow(/Failed to send keys/);

      expect(fake.calls).toHaveLength(1);
    });

    it('enforces per-agent gap between consecutive deliver calls', async () => {
      const { fake, svc } = makeService();

      for (let i = 0; i < 20; i++) {
        fake.enqueueResponse({ type: 'success', stdout: '' });
      }

      const start = Date.now();
      await svc.deliver(target, 'first', {
        agentId: 'same-agent',
        confirm: false,
        postPasteDelayMs: 0,
      });
      await svc.deliver(target, 'second', {
        agentId: 'same-agent',
        confirm: false,
        postPasteDelayMs: 0,
      });
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(400);
    }, 10000);
  });

  describe('deliverImmediate', () => {
    it('bypasses per-agent gap', async () => {
      const { fake, svc } = makeService();

      for (let i = 0; i < 20; i++) {
        fake.enqueueResponse({ type: 'success', stdout: '' });
      }

      const start = Date.now();
      await svc.deliverImmediate(target, 'first', { confirm: false, postPasteDelayMs: 0 });
      await svc.deliverImmediate(target, 'second', { confirm: false, postPasteDelayMs: 0 });
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(300);
    });
  });

  describe('sendControl', () => {
    it('sends control keys via tmux send-keys', async () => {
      const { fake, svc } = makeService();
      fake.enqueueResponse({ type: 'success' });

      await svc.sendControl(target, ['C-c']);

      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0].argv).toEqual(['tmux', 'send-keys', '-t', '=test-session:', 'C-c']);
    });

    it('throws on send-keys failure', async () => {
      const { fake, svc } = makeService();
      fake.enqueueResponse({ type: 'failure', stderr: 'no session' });

      await expect(svc.sendControl(target, ['Enter'])).rejects.toThrow(/Failed to send keys/);
    });
  });
});
