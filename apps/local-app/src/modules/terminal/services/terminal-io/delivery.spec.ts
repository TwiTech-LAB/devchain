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

    it('brackets multiline prompt text and performs no submit-key write when submitKeys is empty', async () => {
      const { fake, svc } = makeService();
      const runSpy = jest.spyOn(fake, 'run');
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      await svc.deliverImmediate(target, 'first line\nsecond line', {
        bracketed: true,
        submitKeys: [],
        confirm: false,
        postPasteDelayMs: 0,
      });

      const loadBufferCall = runSpy.mock.calls.find(
        ([options]) => options.argv[1] === 'load-buffer',
      );
      expect(loadBufferCall?.[0].input).toBe('\x1b[200~first line\rsecond line\x1b[201~');
      expect(fake.calls.filter((call) => call.argv[1] === 'send-keys')).toHaveLength(0);
    });
  });

  // A message delivered while the user is mid-sentence used to be submitted
  // together with their unsent text, and the rest of what they were typing
  // arrived as a second, contextless message. The prompt is a shared surface, so
  // delivery has to move the draft aside and put it back.
  //
  // The draft below is the reason this matters rather than merely confuses:
  // whole, it holds the merge back until a condition is met; cut after "merge
  // PR #10" it orders the merge outright, and agents act on such instructions
  // on their own.
  describe('delivery while the user has an unsent draft', () => {
    const DRAFT = 'merge PR #10 only after the migration test passes';
    const draftKeys = { stash: ['C-e', 'C-u'], restore: ['C-y'] } as const;

    async function typeDraft(fake: FakeProcessExecutor, svc: TerminalIOService, text: string) {
      fake.enqueueResponse({ type: 'success' });
      await svc.sendControl(target, ['-l', '--', text]);
    }

    /** Responses for the draft path up to (not including) the submit. */
    function enqueueStashSequence(fake: FakeProcessExecutor, stashChangedPane = true) {
      fake.enqueueResponse({ type: 'success' }); // if-shell: leave any tmux mode
      fake.enqueueResponse({ type: 'success', stdout: 'prompt with draft' }); // capture before
      fake.enqueueResponse({ type: 'success' }); // stash keys
      fake.enqueueResponse({
        type: 'success',
        stdout: stashChangedPane ? 'prompt now empty' : 'prompt with draft',
      }); // capture after
    }

    function callsWith(fake: FakeProcessExecutor, from: number, needle: string) {
      return fake.calls.slice(from).filter((call) => call.argv.includes(needle));
    }

    it('stashes the draft, submits the message alone, then restores the draft', async () => {
      const { fake, svc } = makeService();
      await typeDraft(fake, svc, DRAFT);
      const from = fake.calls.length;
      enqueueStashSequence(fake);
      fake.enqueueResponse({ type: 'success' }); // load-buffer
      fake.enqueueResponse({ type: 'success' }); // paste-buffer
      fake.enqueueResponse({ type: 'success' }); // delete-buffer
      fake.enqueueResponse({ type: 'success' }); // submit + restore

      const result = await svc.deliver(target, 'agent message', {
        agentId: 'a1',
        confirm: false,
        postPasteDelayMs: 0,
        draftKeys,
      });

      expect(result.confirmed).toBe(true);
      const after = fake.calls.slice(from).map((c) => c.argv.join(' '));
      const idx = (needle: string) => after.findIndex((a) => a.includes(needle));
      // mode is left first, then the stash, then the paste, then the submit
      expect(idx('pane_in_mode')).toBeLessThan(idx('C-u'));
      expect(idx('C-u')).toBeLessThan(idx('paste-buffer'));
      expect(idx('paste-buffer')).toBeLessThan(idx('Enter'));
      expect(idx('Enter')).toBeLessThan(idx('C-y') + 1);
    });

    // A pane in copy-mode consumes send-keys for its own bindings, so the stash
    // would silently do nothing while the paste still landed — at the cursor,
    // inside the draft. Leaving any mode first is what prevents that.
    it('takes the pane out of any tmux mode before sending the stash', async () => {
      const { fake, svc } = makeService();
      await typeDraft(fake, svc, DRAFT);
      const from = fake.calls.length;
      enqueueStashSequence(fake);
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      await svc.deliver(target, 'agent message', {
        agentId: 'a1',
        confirm: false,
        postPasteDelayMs: 0,
        draftKeys,
      });

      const cancel = callsWith(fake, from, 'if-shell')[0];
      expect(cancel).toBeDefined();
      expect(cancel.argv.join(' ')).toContain('#{pane_in_mode}');
      expect(cancel.argv.join(' ')).toContain('cancel');
    });

    // If the stash left the pane unchanged it never reached the provider. Pasting
    // then would drop the message into the middle of the draft, so preservation is
    // abandoned and the message is delivered the ordinary way instead of lost.
    it('falls back to ordinary delivery when the stash cannot be verified', async () => {
      const { fake, svc } = makeService();
      await typeDraft(fake, svc, DRAFT);
      const from = fake.calls.length;
      enqueueStashSequence(fake, false); // pane unchanged after the stash
      // ordinary path: load-buffer, paste-buffer, delete-buffer, submit
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      const result = await svc.deliver(target, 'agent message', {
        agentId: 'a1',
        confirm: false,
        postPasteDelayMs: 0,
        draftKeys,
      });

      expect(result.confirmed).toBe(true);
      // the message still went out, and no restore was attempted
      expect(callsWith(fake, from, 'paste-buffer').length).toBeGreaterThan(0);
      expect(callsWith(fake, from, 'C-y')).toHaveLength(0);
    });

    // The stash keys clear a single line, so a multiline draft keeps its first
    // line and a paste would land after the remnant. Seeing the start of the
    // draft still in the pane is what catches that.
    it('falls back, and hands back what it killed, when the draft is still visible', async () => {
      const { fake, svc } = makeService();
      await typeDraft(fake, svc, DRAFT);
      const from = fake.calls.length;
      fake.enqueueResponse({ type: 'success' }); // if-shell
      fake.enqueueResponse({ type: 'success', stdout: DRAFT }); // capture before
      fake.enqueueResponse({ type: 'success' }); // stash keys
      // the pane changed, but the start of the draft is still sitting there
      fake.enqueueResponse({ type: 'success', stdout: `${DRAFT} (partly cleared)` });
      fake.enqueueResponse({ type: 'success' }); // undo the partial stash
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      const result = await svc.deliver(target, 'agent message', {
        agentId: 'a1',
        confirm: false,
        postPasteDelayMs: 0,
        draftKeys,
      });

      expect(result.confirmed).toBe(true);
      // whatever the stash took is yanked back before the ordinary delivery, or the
      // message would be submitted with that part of the draft missing
      expect(callsWith(fake, from, 'C-y')).toHaveLength(1);
      expect(callsWith(fake, from, 'paste-buffer').length).toBeGreaterThan(0);
    });

    // REGRESSION: the submit once shared a command list with the paste, for
    // atomicity. A provider that assembles a bracketed paste asynchronously then
    // swallows the submit arriving in the same breath, and the message is lost
    // outright — strictly worse than the truncation this path exists to prevent.
    it('never puts the submit in the same command list as the paste', async () => {
      const { fake, svc } = makeService();
      await typeDraft(fake, svc, DRAFT);
      const from = fake.calls.length;
      enqueueStashSequence(fake);
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      await svc.deliver(target, 'agent message', {
        agentId: 'a1',
        confirm: false,
        postPasteDelayMs: 0,
        draftKeys,
      });

      for (const call of fake.calls.slice(from)) {
        expect(call.argv.includes('paste-buffer') && call.argv.includes('Enter')).toBe(false);
      }
    });

    it('leaves delivery untouched when the user has typed nothing', async () => {
      const { fake, svc } = makeService();
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      await svc.deliver(target, 'agent message', {
        agentId: 'a1',
        confirm: false,
        postPasteDelayMs: 0,
        draftKeys,
      });

      const keys = fake.calls.flatMap((call) => call.argv);
      expect(keys).not.toContain('C-u');
      expect(keys).not.toContain('C-y');
      expect(keys.join(' ')).not.toContain('pane_in_mode');
    });

    // Restoring a draft that is not there would yank whatever the provider's kill
    // ring still holds into the prompt, so a committed draft must not count.
    it('does not stash or restore after the user submits their draft', async () => {
      const { fake, svc } = makeService();
      await typeDraft(fake, svc, DRAFT);
      fake.enqueueResponse({ type: 'success' });
      await svc.sendControl(target, ['Enter']);
      const from = fake.calls.length;
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      await svc.deliver(target, 'agent message', {
        agentId: 'a1',
        confirm: false,
        postPasteDelayMs: 0,
        draftKeys,
      });

      expect(callsWith(fake, from, 'C-y')).toHaveLength(0);
    });

    it('skips draft handling for providers that declare no draft keys', async () => {
      const { fake, svc } = makeService();
      await typeDraft(fake, svc, DRAFT);
      const from = fake.calls.length;
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      await svc.deliver(target, 'agent message', {
        agentId: 'a1',
        confirm: false,
        postPasteDelayMs: 0,
      });

      expect(callsWith(fake, from, 'C-u')).toHaveLength(0);
    });

    // Terminals batch fast typing, so a submit can arrive at the tail of a chunk.
    it('treats a submit at the end of a typed chunk as emptying the prompt', async () => {
      const { fake, svc } = makeService();
      await typeDraft(fake, svc, `${DRAFT}\r`);
      const from = fake.calls.length;
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      await svc.deliver(target, 'agent message', {
        agentId: 'a1',
        confirm: false,
        postPasteDelayMs: 0,
        draftKeys,
      });

      expect(callsWith(fake, from, 'C-u')).toHaveLength(0);
    });

    // The stash keys clear one line, so a draft spanning several cannot be moved
    // aside at all. Delivery must not touch it: a partial stash would leave part of
    // the draft in the kill ring and submit the message with the rest.
    it('does not try to stash a multiline draft', async () => {
      const { fake, svc } = makeService();
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      await svc.deliverImmediate(target, 'first line\nsecond line', {
        bracketed: true,
        submitKeys: [],
      });
      const from = fake.calls.length;
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      const result = await svc.deliver(target, 'agent message', {
        agentId: 'a1',
        confirm: false,
        postPasteDelayMs: 0,
        draftKeys,
      });

      // delivered the ordinary way, with the prompt left exactly as the user left it
      expect(result.confirmed).toBe(true);
      expect(callsWith(fake, from, 'paste-buffer').length).toBeGreaterThan(0);
      expect(callsWith(fake, from, 'C-u')).toHaveLength(0);
      expect(callsWith(fake, from, 'C-y')).toHaveLength(0);
      expect(callsWith(fake, from, 'if-shell')).toHaveLength(0);
    });

    // A newline-insert binding grows the draft; treating it as a submit would lose
    // track of the draft and let the next delivery stash a multiline prompt.
    it('counts an escape-prefixed return as a newline, not a submit', async () => {
      const { fake, svc } = makeService();
      await typeDraft(fake, svc, 'first line');
      fake.enqueueResponse({ type: 'success' });
      await svc.sendControl(target, ['-l', '--', '\x1b\r']);
      await typeDraft(fake, svc, 'second line');
      const from = fake.calls.length;
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });

      await svc.deliver(target, 'agent message', {
        agentId: 'a1',
        confirm: false,
        postPasteDelayMs: 0,
        draftKeys,
      });

      // the draft is known to be multiline, so it is left alone
      expect(callsWith(fake, from, 'C-u')).toHaveLength(0);
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
