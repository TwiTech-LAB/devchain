import { TerminalIOService } from './terminal-io.service';
import {
  FakeProcessExecutor,
  type CannedResponse,
} from '../process-executor/fake-process-executor';
import type { SessionTarget, DeliveryOptions } from './types';
import type { EventsService } from '../../../events/services/events.service';
import type { SettingsService } from '../../../settings/services/settings.service';
import { HumanPromptStateService } from '../human-prompt-state.service';
import { FOLLOW_NOTE } from '../../../../common/follow-note';

jest.mock('../../../../common/delivery-nonce', () => ({
  generateDeliveryNonce: () => 'abc1234',
}));

const target: SessionTarget = { name: 'test-session' };
const NONCE = 'abc1234';

function makeService(followNoteEnabled = true) {
  const fake = new FakeProcessExecutor();
  const events = { publish: jest.fn() } as unknown as EventsService;
  const promptState = new HumanPromptStateService();
  const settings = {
    getFollowNoteEnabled: () => followNoteEnabled,
  } as unknown as SettingsService;
  const svc = new TerminalIOService(fake, events, promptState, settings);
  return { fake, promptState, svc };
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

  describe('deliverGuarded', () => {
    function quietSnapshot(promptState: HumanPromptStateService) {
      const draft = promptState.recordPromptText(target.name);
      promptState.transitionToAwaiting(target.name, draft.generation);
      return promptState.getQuietSnapshot(target.name)!;
    }

    it('preserves nonce confirmation after the prepared baseline', async () => {
      const { fake, promptState, svc } = makeService();
      fake.enqueueResponse({ type: 'success', stdout: 'baseline' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success', stdout: `output [MsgId:${NONCE}]` });
      fake.enqueueResponse({ type: 'success' });

      const result = await svc.deliverGuarded(
        target,
        'guarded',
        { agentId: 'a1', confirm: true, postPasteDelayMs: 0 },
        quietSnapshot(promptState),
      );

      expect(result).toEqual(
        expect.objectContaining({ confirmed: true, method: 'nonce', retryCount: 0 }),
      );
      expect(promptState.getState(target.name).phase).toBe('inactive');
      expect(fake.calls.map((call) => call.argv[1])).toEqual([
        'capture-pane',
        'load-buffer',
        'paste-buffer',
        'delete-buffer',
        'capture-pane',
        'send-keys',
      ]);
    });

    it('preserves repair and retry after the guarded first mutation starts', async () => {
      const { fake, promptState, svc } = makeService();
      fake.enqueueResponse({ type: 'success', stdout: 'baseline' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success', stdout: 'not confirmed' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success', stdout: 'retry baseline' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success' });
      fake.enqueueResponse({ type: 'success', stdout: `output [MsgId:${NONCE}]` });
      fake.enqueueResponse({ type: 'success' });

      const result = await svc.deliverGuarded(
        target,
        'guarded retry',
        {
          agentId: 'a1',
          confirm: true,
          confirmTimeoutMs: 0,
          maxAttempts: 2,
          postPasteDelayMs: 0,
        },
        quietSnapshot(promptState),
      );

      expect(result).toEqual(
        expect.objectContaining({ confirmed: true, method: 'nonce', retryCount: 1 }),
      );
      expect(
        fake.calls.some((call) => call.argv[1] === 'send-keys' && call.argv.includes('Escape')),
      ).toBe(true);
    });
  });

  describe('follow note', () => {
    const NOTE_ARGV = ['tmux', 'send-keys', '-t', '=test-session:', '-l', '--', FOLLOW_NOTE];
    const ENTER_ARGV = ['tmux', 'send-keys', '-t', '=test-session:', 'Enter'];

    function noteCalls(fake: FakeProcessExecutor) {
      return fake.calls.filter((c) => c.argv.includes(FOLLOW_NOTE));
    }

    const NOTE_OPTS = { agentId: 'a1', postPasteDelayMs: 0, followNote: true } as const;

    // One confirmed-mode attempt: baseline capture, the three buffer steps, then the check.
    function enqueuePaste(fake: FakeProcessExecutor, confirmation: CannedResponse) {
      fake.enqueueResponse({ type: 'success', stdout: '' }); // baseline
      fake.enqueueResponse({ type: 'success' }); // load-buffer
      fake.enqueueResponse({ type: 'success' }); // paste-buffer
      fake.enqueueResponse({ type: 'success' }); // delete-buffer
      fake.enqueueResponse(confirmation);
    }

    function enqueueConfirmedPaste(fake: FakeProcessExecutor) {
      enqueuePaste(fake, { type: 'success', stdout: `[MsgId:${NONCE}]` });
    }

    it('types the note after paste-buffer and before the submit keys', async () => {
      const { fake, svc } = makeService();
      enqueueConfirmedPaste(fake);

      const result = await svc.deliver(target, 'hello', NOTE_OPTS);

      expect(result.confirmed).toBe(true);
      expect(fake.calls.map((c) => c.argv[1])).toEqual([
        'capture-pane',
        'load-buffer',
        'paste-buffer',
        'delete-buffer',
        'capture-pane',
        'send-keys',
        'send-keys',
      ]);
      expect(fake.calls[5].argv).toEqual(NOTE_ARGV);
      expect(fake.calls[6].argv).toEqual(ENTER_ARGV);
    });

    it('waits at least 100 ms between the note and the submit keys', async () => {
      const { fake, svc } = makeService();
      const writtenAt: number[] = [];
      const run = fake.run.bind(fake);
      jest.spyOn(fake, 'run').mockImplementation((opts) => {
        if (opts.argv[1] === 'send-keys') writtenAt.push(Date.now());
        return run(opts);
      });

      await svc.deliver(target, 'hello', { ...NOTE_OPTS, confirm: false });

      expect(writtenAt).toHaveLength(2);
      expect(writtenAt[1] - writtenAt[0]).toBeGreaterThanOrEqual(95);
    });

    it('types the note once when a capture error counts as delivered', async () => {
      const { fake, svc } = makeService();
      enqueuePaste(fake, { type: 'failure', stderr: 'capture failed' });

      const result = await svc.deliver(target, 'hello', NOTE_OPTS);

      expect(result.confirmed).toBe(true);
      expect(noteCalls(fake)).toHaveLength(1);
      expect(fake.calls.at(-1)!.argv).toEqual(ENTER_ARGV);
    });

    it('types the note once when confirmation is off', async () => {
      const { fake, svc } = makeService();

      await svc.deliver(target, 'hello', { ...NOTE_OPTS, confirm: false });
      await svc.deliverImmediate(target, 'hello', {
        confirm: false,
        postPasteDelayMs: 0,
        followNote: true,
      });

      expect(fake.calls.map((c) => c.argv[1])).toEqual([
        'load-buffer',
        'paste-buffer',
        'delete-buffer',
        'send-keys',
        'send-keys',
        'load-buffer',
        'paste-buffer',
        'delete-buffer',
        'send-keys',
        'send-keys',
      ]);
      expect(fake.calls[3].argv).toEqual(NOTE_ARGV);
      expect(fake.calls[4].argv).toEqual(ENTER_ARGV);
      expect(fake.calls[8].argv).toEqual(NOTE_ARGV);
      expect(fake.calls[9].argv).toEqual(ENTER_ARGV);
    });

    it('types the note once, after the attempt that succeeds', async () => {
      const { fake, svc } = makeService();
      enqueuePaste(fake, { type: 'success', stdout: 'no match' }); // unconfirmed
      fake.enqueueResponse({ type: 'success' }); // Escape
      enqueueConfirmedPaste(fake);

      const result = await svc.deliver(target, 'hello', {
        ...NOTE_OPTS,
        confirmTimeoutMs: 0,
        maxAttempts: 2,
      });

      expect(result).toEqual(expect.objectContaining({ confirmed: true, retryCount: 1 }));
      expect(noteCalls(fake)).toHaveLength(1);
      const noteIndex = fake.calls.findIndex((c) => c.argv.includes(FOLLOW_NOTE));
      const lastPasteIndex = fake.calls.map((c) => c.argv[1]).lastIndexOf('paste-buffer');
      const escapeIndex = fake.calls.findIndex((c) => c.argv.includes('Escape'));
      expect(escapeIndex).toBeLessThan(lastPasteIndex);
      expect(noteIndex).toBeGreaterThan(lastPasteIndex);
      expect(fake.calls[noteIndex + 1].argv).toEqual(ENTER_ARGV);
    });

    it('writes the note once when the submit keys fail and the retry succeeds', async () => {
      const { fake, svc } = makeService();
      enqueueConfirmedPaste(fake);
      fake.enqueueResponse({ type: 'success' }); // note
      fake.enqueueResponse({ type: 'failure', stderr: 'transient' }); // Enter
      fake.enqueueResponse({ type: 'success' }); // Enter retry

      const result = await svc.deliver(target, 'hello', NOTE_OPTS);

      expect(result.confirmed).toBe(true);
      expect(noteCalls(fake)).toHaveLength(1);
      expect(fake.calls.filter((c) => c.argv.includes('Enter'))).toHaveLength(2);
    });

    it('still sends the submit keys when the note write fails', async () => {
      const { fake, svc } = makeService();
      enqueueConfirmedPaste(fake);
      fake.enqueueResponse({ type: 'failure', stderr: 'note failed' }); // note
      fake.enqueueResponse({ type: 'success' }); // Enter

      const result = await svc.deliver(target, 'hello', NOTE_OPTS);

      expect(result.confirmed).toBe(true);
      expect(noteCalls(fake)).toHaveLength(1);
      expect(fake.calls.at(-1)!.argv).toEqual(ENTER_ARGV);
    });

    it('does not type the note when the paste is never confirmed', async () => {
      const { fake, svc } = makeService();
      for (let attempt = 0; attempt < 2; attempt++) {
        enqueuePaste(fake, { type: 'success', stdout: 'nope' });
        if (attempt < 1) fake.enqueueResponse({ type: 'success' }); // Escape
      }

      const result = await svc.deliver(target, 'hello', {
        ...NOTE_OPTS,
        confirmTimeoutMs: 0,
        maxAttempts: 2,
      });

      expect(result.confirmed).toBe(false);
      expect(noteCalls(fake)).toHaveLength(0);
      expect(fake.calls.at(-1)!.argv).toEqual(ENTER_ARGV);
    });

    it.each<[string, string, Omit<DeliveryOptions, 'agentId'>]>([
      ['submitKeys is empty', 'hello', { submitKeys: [], followNote: true }],
      ['bracketed is false', 'hello', { bracketed: false, followNote: true }],
      ['followNote is false', 'hello', { followNote: false }],
      ['followNote is unset', 'hello', {}],
      ['the text is a provider command', '/compact', { followNote: true }],
      ['the text is a shell command', '!git status', { followNote: true }],
      ['the command follows spaces', '   /compact', { followNote: true }],
      ['the command follows a newline', '\n\t!git status', { followNote: true }],
    ])('does not type the note when %s', async (_label, text, options) => {
      const { fake, svc } = makeService();

      await svc.deliver(target, text, {
        agentId: 'a1',
        confirm: false,
        postPasteDelayMs: 0,
        ...options,
      });
      await svc.deliverImmediate(target, text, { confirm: false, postPasteDelayMs: 0, ...options });

      expect(fake.calls.filter((c) => c.argv[1] === 'paste-buffer')).toHaveLength(2);
      expect(noteCalls(fake)).toHaveLength(0);
    });

    it('types the note for a message that only mentions a command', async () => {
      const { fake, svc } = makeService();

      await svc.deliverImmediate(target, 'please run /compact', {
        confirm: false,
        postPasteDelayMs: 0,
        followNote: true,
      });

      expect(noteCalls(fake)).toHaveLength(1);
    });

    it('makes no pane writes, including the note, when the human-draft guard refuses', async () => {
      const { fake, promptState, svc } = makeService();
      const draft = promptState.recordPromptText(target.name);
      promptState.transitionToAwaiting(target.name, draft.generation);
      const snapshot = promptState.getQuietSnapshot(target.name)!;
      promptState.recordExecutedInput(target.name);

      const result = await svc.deliverGuarded(
        target,
        'hello',
        { ...NOTE_OPTS, confirm: false },
        snapshot,
      );

      expect(result).toEqual({ deferred: 'human_draft' });
      expect(fake.calls.map((c) => c.argv[1])).toEqual(['load-buffer', 'delete-buffer']);
    });

    it('keeps the note free of paste-confirmation and submit triggers', () => {
      expect(FOLLOW_NOTE).not.toMatch(/pasted/i);
      expect(FOLLOW_NOTE).not.toMatch(/[\r\n]/);
      expect(FOLLOW_NOTE).not.toContain('[MsgId:');
    });

    describe('settings gate', () => {
      it('deliver does not type the note when the switch is off', async () => {
        const { fake, svc } = makeService(false);

        const result = await svc.deliver(target, 'hello', { ...NOTE_OPTS, confirm: false });

        expect(result.confirmed).toBe(true);
        expect(noteCalls(fake)).toHaveLength(0);
        expect(fake.calls.map((c) => c.argv[1])).toEqual([
          'load-buffer',
          'paste-buffer',
          'delete-buffer',
          'send-keys',
        ]);
      });

      it('deliverImmediate does not type the note when the switch is off', async () => {
        const { fake, svc } = makeService(false);

        await svc.deliverImmediate(target, 'hello', {
          confirm: false,
          postPasteDelayMs: 0,
          followNote: true,
        });

        expect(noteCalls(fake)).toHaveLength(0);
        expect(fake.calls.map((c) => c.argv[1])).toEqual([
          'load-buffer',
          'paste-buffer',
          'delete-buffer',
          'send-keys',
        ]);
      });

      it('deliverGuarded does not type the note when the switch is off', async () => {
        const { fake, promptState, svc } = makeService(false);
        const draft = promptState.recordPromptText(target.name);
        promptState.transitionToAwaiting(target.name, draft.generation);
        const snapshot = promptState.getQuietSnapshot(target.name)!;

        const result = await svc.deliverGuarded(
          target,
          'hello',
          { ...NOTE_OPTS, confirm: false },
          snapshot,
        );

        expect(result).toEqual(expect.objectContaining({ confirmed: true }));
        expect(noteCalls(fake)).toHaveLength(0);
        expect(fake.calls.map((c) => c.argv[1])).toEqual([
          'load-buffer',
          'paste-buffer',
          'delete-buffer',
          'send-keys',
        ]);
      });
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
