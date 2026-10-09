import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import {
  sessionHumanPromptStateChangedEvent,
  type SessionHumanPromptStateChangedEventPayload,
} from '../../events/catalog/session.human-prompt-state-changed';
import { HumanPromptInputService, type PromptInput } from './human-prompt-input.service';
import { HumanPromptStateService } from './human-prompt-state.service';

describe('HumanPromptInputService', () => {
  let moduleRef: TestingModule;
  let input: HumanPromptInputService;
  let state: HumanPromptStateService;
  let events: EventEmitter2;
  let session: { sessionId: string; tmuxSessionName: string; signalInput: jest.Mock };

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(1000);
    moduleRef = await Test.createTestingModule({
      providers: [HumanPromptInputService, HumanPromptStateService, EventEmitter2],
    }).compile();
    input = moduleRef.get(HumanPromptInputService);
    state = moduleRef.get(HumanPromptStateService);
    events = moduleRef.get(EventEmitter2);
    session = {
      sessionId: 'human-input',
      tmuxSessionName: 'tmux_human_input',
      signalInput: jest.fn(),
    };
  });

  afterEach(async () => {
    await moduleRef.close();
    jest.useRealTimers();
  });

  async function draft(characterCount = 1): Promise<void> {
    await input.run(session, { kind: 'text', characterCount }, async () => undefined);
    session.signalInput.mockClear();
  }

  function control(tmuxKey: string): Extract<PromptInput, { kind: 'control' }> {
    return {
      kind: 'control',
      tmuxKey,
      expectedGeneration: input.observe(session.tmuxSessionName),
    };
  }

  function inputFor(kind: 'text' | 'paste' | 'submit-text' | 'control'): PromptInput {
    return kind === 'control' ? control('Enter') : { kind };
  }

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  // Module-unit: the real in-memory state and events expose observation without terminal I/O.
  it.each(['inactive', 'draft_active', 'awaiting_stable_idle'] as const)(
    'observe returns only the draft generation in phase %s',
    async (phase) => {
      if (phase !== 'inactive') await draft();
      if (phase === 'awaiting_stable_idle') {
        await input.run(session, control('Enter'), async () => undefined);
      }

      expect(input.observe(session.tmuxSessionName)).toBe(phase === 'draft_active' ? 1 : null);
    },
  );

  // Module-unit: a parked real event listener catches ordering bugs a mocked barrier would hide.
  it.each(['text', 'paste', 'submit-text'] as const)(
    '%s waits for activation listeners before signaling or writing and returns the write result',
    async (kind) => {
      const activation = deferred();
      const promotion = deferred();
      events.on(
        sessionHumanPromptStateChangedEvent.name,
        (event: SessionHumanPromptStateChangedEventPayload) => {
          if (event.phase === 'draft_active') {
            activation.resolve();
            return promotion.promise;
          }
        },
      );
      const value = { delivered: kind };
      const write = jest.fn(async () => {
        expect(session.signalInput).toHaveBeenCalledTimes(1);
        return value;
      });

      const run = input.run(session, { kind }, write);
      await activation.promise;
      expect(input.observe(session.tmuxSessionName)).toBe(1);
      expect(session.signalInput).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();

      promotion.resolve();
      await expect(run).resolves.toBe(value);
      expect(write).toHaveBeenCalledTimes(1);
      expect(state.getState(session.tmuxSessionName).phase).toBe(
        kind === 'submit-text' ? 'awaiting_stable_idle' : 'draft_active',
      );
    },
  );

  // Module-unit: resulting state and real event payloads prove the shared protocol's phase contract.
  it.each([
    { key: 'Left', phase: 'draft_active' },
    { key: 'Right', phase: 'draft_active' },
    { key: 'Up', phase: 'draft_active' },
    { key: 'Down', phase: 'draft_active' },
    { key: 'Tab', phase: 'draft_active' },
    { key: 'Escape', phase: 'draft_active' },
    { key: 'Unknown', phase: 'draft_active' },
    { key: 'Enter', phase: 'awaiting_stable_idle' },
    { key: 'double Escape', phase: 'awaiting_stable_idle' },
    { key: 'BSpace', phase: 'awaiting_stable_idle' },
    { key: 'C-c', providerName: 'codex', phase: 'awaiting_stable_idle' },
    { key: 'C-c', providerName: 'claude', phase: 'draft_active' },
  ] as const)('$key emits the resulting $phase phase', async (testCase) => {
    await draft();
    if (testCase.key === 'double Escape') {
      await input.run(session, control('Escape'), async () => undefined);
    }
    const published: SessionHumanPromptStateChangedEventPayload[] = [];
    events.on(
      sessionHumanPromptStateChangedEvent.name,
      (event: SessionHumanPromptStateChangedEventPayload) => {
        published.push(event);
      },
    );
    const key = testCase.key === 'double Escape' ? 'Escape' : testCase.key;
    const write = jest.fn(async () => {
      expect(session.signalInput).toHaveBeenCalled();
      expect(published).toEqual([]);
      return 'written';
    });

    await expect(
      input.run(
        session,
        {
          ...control(key),
          providerName: 'providerName' in testCase ? testCase.providerName : undefined,
        },
        write,
      ),
    ).resolves.toBe('written');

    const resultingState = state.getState(session.tmuxSessionName);
    expect(resultingState.phase).toBe(testCase.phase);
    expect(published).toEqual([
      {
        sessionId: session.sessionId,
        tmuxSessionName: session.tmuxSessionName,
        generation: resultingState.generation,
        phase: resultingState.phase,
      },
    ]);
  });

  // Module-unit: a newer input through the interface proves stale observations cannot publish or transition.
  it.each(['Enter', 'Left'] as const)('%s ignores a stale expected generation', async (key) => {
    await draft();
    const observed = control(key);
    await draft();
    const newer = state.getState(session.tmuxSessionName);
    const published = jest.fn();
    events.on(sessionHumanPromptStateChangedEvent.name, published);
    const write = jest.fn().mockResolvedValue('written');

    await expect(input.run(session, observed, write)).resolves.toBe('written');

    expect(write).toHaveBeenCalledTimes(1);
    expect(state.getState(session.tmuxSessionName)).toEqual(newer);
    expect(published).not.toHaveBeenCalled();
  });

  // Module-unit: a parked write and newer input exercise the generation fence without caller fixtures.
  it.each(['submit-text', 'control'] as const)(
    '%s cannot clear a newer draft activated during its write',
    async (kind) => {
      if (kind === 'control') await draft();
      const writing = deferred();
      const pending = deferred();
      const run = input.run(session, inputFor(kind), () => {
        writing.resolve();
        return pending.promise;
      });
      await writing.promise;
      await draft();
      const newer = state.getState(session.tmuxSessionName);
      const published = jest.fn();
      events.on(sessionHumanPromptStateChangedEvent.name, published);

      pending.resolve();
      await run;

      expect(state.getState(session.tmuxSessionName)).toEqual(newer);
      expect(input.observe(session.tmuxSessionName)).toBe(2);
      expect(published).not.toHaveBeenCalled();
    },
  );

  // Module-unit: accepted writes with no observed draft need no tmux or caller fixture to check no activation.
  it.each(['Enter', 'Unknown'] as const)(
    '%s with no observed draft writes without publishing',
    async (key) => {
      const published = jest.fn();
      events.on(sessionHumanPromptStateChangedEvent.name, published);

      await input.run(session, control(key), async () => undefined);

      expect(session.signalInput).toHaveBeenCalledTimes(1);
      expect(state.getState(session.tmuxSessionName).phase).toBe('inactive');
      expect(published).not.toHaveBeenCalled();
    },
  );

  // Module-unit: parking the write exposes premature confirmation with real pending-write state.
  it.each([
    { kind: 'text', finalPhase: 'draft_active' },
    { kind: 'paste', finalPhase: 'draft_active' },
    { kind: 'submit-text', finalPhase: 'awaiting_stable_idle' },
  ] as const)(
    'Enter cannot finish a $kind draft while its write is pending',
    async ({ kind, finalPhase }) => {
      const writing = deferred();
      const pending = deferred();
      const run = input.run(session, { kind }, () => {
        writing.resolve();
        return pending.promise;
      });
      await writing.promise;

      await input.run(session, control('Enter'), async () => undefined);
      expect(state.getState(session.tmuxSessionName).phase).toBe('draft_active');

      pending.resolve();
      await run;
      expect(state.getState(session.tmuxSessionName).phase).toBe(finalPhase);
    },
  );

  // Module-unit: parking the write exposes a premature transition with real pending-write state.
  it('Enter does not transition the draft before its own write settles', async () => {
    await draft();
    const writing = deferred();
    const pending = deferred();
    const run = input.run(session, control('Enter'), () => {
      writing.resolve();
      return pending.promise;
    });
    await writing.promise;
    expect(state.getState(session.tmuxSessionName).phase).toBe('draft_active');

    pending.resolve();
    await run;
    expect(state.getState(session.tmuxSessionName).phase).toBe('awaiting_stable_idle');
  });

  // Module-unit: failure propagation and a subsequent rejected Enter prove no write was confirmed.
  it.each(['text', 'paste', 'submit-text'] as const)(
    '%s propagates a failed write without confirmation or a post-write event',
    async (kind) => {
      const before = state.getState(session.tmuxSessionName);
      const published: SessionHumanPromptStateChangedEventPayload[] = [];
      events.on(
        sessionHumanPromptStateChangedEvent.name,
        (event: SessionHumanPromptStateChangedEventPayload) => {
          published.push(event);
        },
      );
      const error = new Error('terminal write failed');

      await expect(
        input.run(session, { kind }, async () => {
          throw error;
        }),
      ).rejects.toBe(error);

      expect(state.getState(session.tmuxSessionName)).toEqual({
        ...before,
        phase: 'draft_active',
        generation: before.generation + 1,
      });
      expect(published.map((event) => event.phase)).toEqual(['draft_active']);
      published.length = 0;
      await input.run(session, control('Enter'), async () => undefined);
      expect(state.getState(session.tmuxSessionName).phase).toBe('draft_active');
      expect(published).toEqual([]);
    },
  );

  // Module-unit: failure propagation with the real state proves a failed key never transitions.
  it.each(['Enter', 'Left'] as const)(
    '%s propagates a failed write without transition or event',
    async (key) => {
      await draft();
      const before = state.getState(session.tmuxSessionName);
      const published = jest.fn();
      events.on(sessionHumanPromptStateChangedEvent.name, published);
      const error = new Error('terminal write failed');

      await expect(
        input.run(session, control(key), async () => {
          throw error;
        }),
      ).rejects.toBe(error);

      expect(state.getState(session.tmuxSessionName)).toEqual(before);
      expect(published).not.toHaveBeenCalled();
    },
  );

  // Module-unit: a real submit listener verifies run's completion barrier without callers or pane I/O.
  it.each(['submit-text', 'control'] as const)(
    '%s awaits accepted submit listeners before resolving',
    async (kind) => {
      if (kind === 'control') await draft();
      const submitted = deferred();
      const barrier = deferred();
      events.on(
        sessionHumanPromptStateChangedEvent.name,
        (event: SessionHumanPromptStateChangedEventPayload) => {
          if (event.phase === 'awaiting_stable_idle') {
            submitted.resolve();
            return barrier.promise;
          }
        },
      );
      let settled = false;
      const run = input
        .run(session, inputFor(kind), async () => 'written')
        .then((value) => {
          settled = true;
          return value;
        });
      await submitted.promise;

      expect(state.getState(session.tmuxSessionName).phase).toBe('awaiting_stable_idle');
      expect(settled).toBe(false);
      barrier.resolve();
      await expect(run).resolves.toBe('written');
    },
  );
});
