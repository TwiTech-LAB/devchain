import type { EventsService } from '../../../events/services/events.service';
import { HumanPromptStateService, type ForcePromptSnapshot } from '../human-prompt-state.service';
import type {
  DaemonSpawnOptions,
  ExecutorResult,
  ProcessExecutorOptions,
} from '../process-executor/process-executor.port';
import { ProcessExecutor } from '../process-executor/process-executor.port';
import { TerminalIOClosingError, TerminalIOService } from './terminal-io.service';

const SUCCESS: ExecutorResult = {
  success: true,
  exitCode: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  truncated: false,
};

const activeServices: TerminalIOService[] = [];

class ControlledExecutor extends ProcessExecutor {
  readonly calls: ProcessExecutorOptions[] = [];
  onRun?: (options: ProcessExecutorOptions) => void;
  private readonly heldInputs = new Map<string, () => void>();
  private readonly inputStarted = new Map<string, () => void>();
  private readonly waitingInputs = new Map<string, Promise<ExecutorResult>>();
  private readonly failingInputs = new Set<string>();
  private heldCommand:
    | {
        command: string;
        started: Promise<void>;
        markStarted: () => void;
        released: Promise<void>;
        release: () => void;
      }
    | undefined;

  holdInput(input: string): { started: Promise<void>; release: () => void } {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const promise = new Promise<ExecutorResult>((resolve) => {
      release = () => resolve(SUCCESS);
    });
    this.heldInputs.set(input, release);
    this.inputStarted.set(input, markStarted);
    this.waitingInputs.set(input, promise);
    return { started, release: () => this.releaseInput(input) };
  }

  releaseInput(input: string): void {
    this.heldInputs.get(input)?.();
    this.heldInputs.delete(input);
    this.inputStarted.delete(input);
    this.waitingInputs.delete(input);
  }

  failInput(input: string): void {
    this.failingInputs.add(input);
  }

  holdCommand(command: string): { started: Promise<void>; release: () => void } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.heldCommand = { command, started, markStarted, released, release };
    return { started, release };
  }

  async run(options: ProcessExecutorOptions): Promise<ExecutorResult> {
    this.calls.push(options);
    this.onRun?.(options);
    const heldCommand = this.heldCommand;
    if (heldCommand?.command === options.argv[1]) {
      heldCommand.markStarted();
      await heldCommand.released;
      this.heldCommand = undefined;
    }
    if (options.argv[1] === 'load-buffer' && options.input) {
      const failing = [...this.failingInputs].find((input) => options.input?.includes(input));
      if (failing) {
        return { ...SUCCESS, success: false, exitCode: 1, stderr: 'load failed' };
      }
      const held = [...this.waitingInputs.keys()].find((input) => options.input?.includes(input));
      const waiting = held ? this.waitingInputs.get(held) : undefined;
      if (waiting) {
        this.inputStarted.get(held!)?.();
        return waiting;
      }
    }
    return SUCCESS;
  }

  async spawnDaemon(_options: DaemonSpawnOptions): Promise<{ pid: number }> {
    return { pid: 1 };
  }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

function makeService(): {
  executor: ControlledExecutor;
  promptState: HumanPromptStateService;
  service: TerminalIOService;
} {
  const executor = new ControlledExecutor();
  const promptState = new HumanPromptStateService();
  const events = { publish: jest.fn() } as unknown as EventsService;
  const service = new TerminalIOService(executor, events, promptState);
  activeServices.push(service);
  return { executor, promptState, service };
}

const immediateOptions = { confirm: false, postPasteDelayMs: 0, submitKeys: [] } as const;

describe('TerminalIOService pane FIFO', () => {
  afterEach(async () => {
    await Promise.all(
      activeServices.splice(0).map((service) => service.beforeApplicationShutdown()),
    );
  });

  it('runs writes for one pane in call order', async () => {
    const { executor, service } = makeService();
    executor.holdInput('first');

    const first = service.deliverImmediate({ name: 'pane-a' }, 'first', immediateOptions);
    await settle();
    const second = service.deliverImmediate({ name: 'pane-a' }, 'second', immediateOptions);
    await settle();

    expect(executor.calls.filter((call) => call.argv[1] === 'load-buffer')).toHaveLength(1);

    executor.releaseInput('first');
    await Promise.all([first, second]);

    const inputs = executor.calls
      .filter((call) => call.argv[1] === 'load-buffer')
      .map((call) => call.input);
    expect(inputs[0]).toContain('first');
    expect(inputs[1]).toContain('second');
    const states = (service as unknown as { paneDeliveryStates: Map<string, unknown> })
      .paneDeliveryStates;
    expect(states.size).toBe(0);
  });

  it('shares one FIFO across immediate, control, and confirmed delivery APIs', async () => {
    const { executor, service } = makeService();
    executor.holdInput('first');

    const immediate = service.deliverImmediate({ name: 'pane-a' }, 'first', immediateOptions);
    await settle();
    const control = service.sendControl({ name: 'pane-a' }, ['C-c']);
    const delivery = service.deliver({ name: 'pane-a' }, 'third', {
      agentId: 'agent-a',
      confirm: false,
      postPasteDelayMs: 0,
      submitKeys: [],
    });
    await settle();

    expect(executor.calls).toHaveLength(1);
    executor.releaseInput('first');
    await Promise.all([immediate, control, delivery]);

    const mutationOrder = executor.calls
      .filter((call) => call.argv[1] === 'load-buffer' || call.argv[1] === 'send-keys')
      .map((call) => (call.argv[1] === 'send-keys' ? call.argv.at(-1) : call.input));
    expect(mutationOrder[0]).toContain('first');
    expect(mutationOrder[1]).toBe('C-c');
    expect(mutationOrder[2]).toContain('third');
  });

  it('allows different panes to progress independently', async () => {
    const { executor, service } = makeService();
    executor.holdInput('blocked');

    const blocked = service.deliverImmediate({ name: 'pane-a' }, 'blocked', immediateOptions);
    await settle();
    const independent = service.deliverImmediate(
      { name: 'pane-b' },
      'independent',
      immediateOptions,
    );
    await independent;

    const inputs = executor.calls
      .filter((call) => call.argv[1] === 'load-buffer')
      .map((call) => call.input);
    expect(inputs[0]).toContain('blocked');
    expect(inputs[1]).toContain('independent');

    executor.releaseInput('blocked');
    await blocked;
  });

  it('continues the pane queue after a failed write', async () => {
    const { executor, service } = makeService();
    executor.failInput('failed');

    const failed = service.deliverImmediate({ name: 'pane-a' }, 'failed', immediateOptions);
    const next = service.deliverImmediate({ name: 'pane-a' }, 'next', immediateOptions);

    await expect(failed).rejects.toThrow('load failed');
    await expect(next).resolves.toEqual(expect.objectContaining({ confirmed: true }));
  });

  it('defers a stale quiet snapshot after buffer preparation without pane mutation', async () => {
    const { executor, promptState, service } = makeService();
    const draft = promptState.recordPromptText('pane-a');
    promptState.transitionToAwaiting('pane-a', draft.generation);
    const snapshot = promptState.getQuietSnapshot('pane-a');
    promptState.recordMeaningfulOutput('pane-a');

    await expect(
      service.deliverGuarded(
        { name: 'pane-a' },
        'protected',
        { agentId: 'agent-a', confirm: false, postPasteDelayMs: 0 },
        snapshot!,
      ),
    ).resolves.toEqual({ deferred: 'human_draft' });

    expect(executor.calls.map((call) => call.argv[1])).toEqual(['load-buffer', 'delete-buffer']);
    expect(promptState.getState('pane-a').phase).toBe('awaiting_stable_idle');
  });

  it('retains ownership through held confirmation preflight and defers changed output', async () => {
    const { executor, promptState, service } = makeService();
    const draft = promptState.recordPromptText('pane-a');
    promptState.transitionToAwaiting('pane-a', draft.generation);
    const snapshot = promptState.getQuietSnapshot('pane-a');
    const baseline = executor.holdCommand('capture-pane');

    const guarded = service.deliverGuarded(
      { name: 'pane-a' },
      'must not mutate',
      {
        agentId: 'agent-a',
        confirm: true,
        confirmTimeoutMs: 0,
        maxAttempts: 1,
        preKeys: ['Escape'],
        preDelayMs: 25,
        postPasteDelayMs: 0,
        submitKeys: ['Enter'],
      },
      snapshot!,
    );
    await baseline.started;

    const phaseDuringPreflight = promptState.getState('pane-a').phase;
    promptState.recordMeaningfulOutput('pane-a');
    baseline.release();

    expect(phaseDuringPreflight).toBe('awaiting_stable_idle');
    await expect(guarded).resolves.toEqual({ deferred: 'human_draft' });
    expect(executor.calls.map((call) => call.argv[1])).toEqual([
      'capture-pane',
      'load-buffer',
      'delete-buffer',
    ]);
    expect(promptState.getState('pane-a').phase).toBe('awaiting_stable_idle');
  });

  it.each([
    [
      'meaningful output',
      (promptState: HumanPromptStateService) => promptState.recordMeaningfulOutput('pane-a'),
    ],
    [
      'executed input',
      (promptState: HumanPromptStateService) => promptState.recordExecutedInput('pane-a'),
    ],
  ])(
    'cleans a prepared buffer and defers when %s changes during load-buffer',
    async (_activity, recordActivity) => {
      const { executor, promptState, service } = makeService();
      const draft = promptState.recordPromptText('pane-a');
      promptState.transitionToAwaiting('pane-a', draft.generation);
      const snapshot = promptState.getQuietSnapshot('pane-a');
      const load = executor.holdInput('held buffer payload');

      const guarded = service.deliverGuarded(
        { name: 'pane-a' },
        'held buffer payload',
        {
          agentId: 'agent-a',
          confirm: true,
          confirmTimeoutMs: 0,
          maxAttempts: 1,
          preKeys: ['Escape'],
          preDelayMs: 25,
          postPasteDelayMs: 0,
          submitKeys: ['Enter'],
        },
        snapshot!,
      );
      await load.started;

      const phaseDuringLoad = promptState.getState('pane-a').phase;
      recordActivity(promptState);
      load.release();

      await expect(guarded).resolves.toEqual({ deferred: 'human_draft' });
      expect(phaseDuringLoad).toBe('awaiting_stable_idle');
      expect(executor.calls.map((call) => call.argv[1])).toEqual([
        'capture-pane',
        'load-buffer',
        'delete-buffer',
      ]);
      expect(promptState.getState('pane-a').phase).toBe('awaiting_stable_idle');
    },
  );

  it('retains ownership through the send gap and defers changed input without mutation', async () => {
    const { executor, promptState, service } = makeService();
    await service.deliver({ name: 'pane-a' }, 'prime gap', {
      agentId: 'agent-a',
      confirm: false,
      postPasteDelayMs: 0,
      submitKeys: [],
    });
    const callCountBeforeGuard = executor.calls.length;
    const draft = promptState.recordPromptText('pane-a');
    promptState.transitionToAwaiting('pane-a', draft.generation);
    const snapshot = promptState.getQuietSnapshot('pane-a');

    const guarded = service.deliverGuarded(
      { name: 'pane-a' },
      'blocked during gap',
      { agentId: 'agent-a', confirm: false, postPasteDelayMs: 0 },
      snapshot!,
    );
    await settle();

    expect(promptState.getState('pane-a').phase).toBe('awaiting_stable_idle');
    promptState.recordExecutedInput('pane-a');

    await expect(guarded).resolves.toEqual({ deferred: 'human_draft' });
    expect(executor.calls.slice(callCountBeforeGuard).map((call) => call.argv[1])).toEqual([
      'load-buffer',
      'delete-buffer',
    ]);
    expect(promptState.getState('pane-a').phase).toBe('awaiting_stable_idle');
  });

  it('rechecks the full quiet snapshot after queued navigation reaches the FIFO head', async () => {
    const { executor, promptState, service } = makeService();
    executor.holdInput('in-flight');
    const inFlight = service.deliverImmediate({ name: 'pane-a' }, 'in-flight', immediateOptions);
    await settle();

    const draft = promptState.recordPromptText('pane-a');
    promptState.transitionToAwaiting('pane-a', draft.generation);
    const snapshot = promptState.getQuietSnapshot('pane-a');
    promptState.recordExecutedInput('pane-a');
    const navigation = service.sendControl({ name: 'pane-a' }, ['Left']);
    const protectedDelivery = service.deliverGuarded(
      { name: 'pane-a' },
      'must remain held',
      { agentId: 'agent-a', confirm: false, postPasteDelayMs: 0 },
      snapshot!,
    );

    executor.releaseInput('in-flight');
    await inFlight;
    await navigation;
    await expect(protectedDelivery).resolves.toEqual({ deferred: 'human_draft' });

    const paneMutations = executor.calls.filter(
      (call) => call.argv[1] === 'paste-buffer' || call.argv[1] === 'send-keys',
    );
    expect(paneMutations.map((call) => call.argv[1])).toEqual(['paste-buffer', 'send-keys']);
    expect(paneMutations[1].argv.at(-1)).toBe('Left');
    expect(executor.calls.filter((call) => call.argv[1] === 'paste-buffer')).toHaveLength(1);
  });

  it('releases a matching snapshot and starts its write at the FIFO head', async () => {
    const { executor, promptState, service } = makeService();
    const draft = promptState.recordPromptText('pane-a');
    promptState.transitionToAwaiting('pane-a', draft.generation);
    const snapshot = promptState.getQuietSnapshot('pane-a');

    const result = await service.deliverGuarded(
      { name: 'pane-a' },
      'protected',
      { agentId: 'agent-a', confirm: false, postPasteDelayMs: 0 },
      snapshot!,
    );

    expect(result).toEqual(expect.objectContaining({ confirmed: true }));
    expect(promptState.getState('pane-a').phase).toBe('inactive');
    expect(executor.calls[0].input).toContain('protected\r[MsgId:');
  });

  it('starts the first mutation before a post-release microtask can run', async () => {
    const { executor, promptState, service } = makeService();
    const draft = promptState.recordPromptText('pane-a');
    promptState.transitionToAwaiting('pane-a', draft.generation);
    const snapshot = promptState.getQuietSnapshot('pane-a')!;
    const releaseIfQuiet = promptState.releaseIfQuiet.bind(promptState);
    jest.spyOn(promptState, 'releaseIfQuiet').mockImplementation((...args) => {
      const released = releaseIfQuiet(...args);
      if (released) queueMicrotask(() => promptState.recordMeaningfulOutput('pane-a'));
      return released;
    });
    let meaningfulOutputEpochAtPaste = -1;
    executor.onRun = (options) => {
      if (options.argv[1] === 'paste-buffer') {
        meaningfulOutputEpochAtPaste = promptState.getState('pane-a').meaningfulOutputEpoch;
      }
    };

    await service.deliverGuarded(
      { name: 'pane-a' },
      'protected',
      {
        agentId: 'agent-a',
        confirm: false,
        postPasteDelayMs: 0,
        submitKeys: [],
      },
      snapshot,
    );

    expect(meaningfulOutputEpochAtPaste).toBe(snapshot.meaningfulOutputEpoch);
    expect(promptState.getState('pane-a').meaningfulOutputEpoch).toBe(
      snapshot.meaningfulOutputEpoch + 1,
    );
  });

  describe('force delivery guard (real TerminalIOService + HumanPromptState)', () => {
    function makeForceFence(
      promptState: HumanPromptStateService,
      paneName: string,
      forceSnapshot: ForcePromptSnapshot,
      claimState: { phase: string; cancelled?: boolean },
    ) {
      return {
        canStartMutation: () => {
          if (claimState.phase !== 'preparing' || claimState.cancelled) return false;
          return promptState.applyForceDelivery(paneName, forceSnapshot);
        },
        markMutationStarted: () => {
          if (claimState.phase === 'preparing' && !claimState.cancelled) {
            claimState.phase = 'mutating';
          }
        },
      };
    }

    it('succeeds for awaiting_stable_idle and transitions to inactive', async () => {
      const { executor, promptState, service } = makeService();
      const draft = promptState.recordPromptText('pane-a');
      promptState.transitionToAwaiting('pane-a', draft.generation);
      const forceSnapshot = promptState.getForceSnapshot('pane-a')!;
      const claimState = { phase: 'preparing' };

      const result = await service.deliverGuarded(
        { name: 'pane-a' },
        'force-delivered',
        { agentId: 'agent-a', confirm: false, postPasteDelayMs: 0 },
        undefined,
        makeForceFence(promptState, 'pane-a', forceSnapshot, claimState),
      );

      expect(result).toEqual(expect.objectContaining({ confirmed: true }));
      expect(promptState.getState('pane-a').phase).toBe('inactive');
      expect(executor.calls[0].input).toContain('force-delivered');
    });

    it('succeeds for inactive phase and keeps it inactive', async () => {
      const { executor, promptState, service } = makeService();
      const forceSnapshot = promptState.getForceSnapshot('pane-a')!;
      expect(forceSnapshot.phase).toBe('inactive');
      const claimState = { phase: 'preparing' };

      const result = await service.deliverGuarded(
        { name: 'pane-a' },
        'force-inactive',
        { agentId: 'agent-a', confirm: false, postPasteDelayMs: 0 },
        undefined,
        makeForceFence(promptState, 'pane-a', forceSnapshot, claimState),
      );

      expect(result).toEqual(expect.objectContaining({ confirmed: true }));
      expect(promptState.getState('pane-a').phase).toBe('inactive');
      expect(executor.calls[0].input).toContain('force-inactive');
    });

    it('defers when typing is injected after buffer prep for awaiting_stable_idle', async () => {
      const { executor, promptState, service } = makeService();
      const draft = promptState.recordPromptText('pane-a');
      promptState.transitionToAwaiting('pane-a', draft.generation);
      const forceSnapshot = promptState.getForceSnapshot('pane-a')!;
      const claimState = { phase: 'preparing' };
      const load = executor.holdInput('force-held');

      const guarded = service.deliverGuarded(
        { name: 'pane-a' },
        'force-held',
        { agentId: 'agent-a', confirm: false, postPasteDelayMs: 0 },
        undefined,
        makeForceFence(promptState, 'pane-a', forceSnapshot, claimState),
      );
      await load.started;

      promptState.recordPromptText('pane-a');
      load.release();

      await expect(guarded).resolves.toEqual({ deferred: 'human_draft' });
      expect(executor.calls.map((call) => call.argv[1])).toEqual(['load-buffer', 'delete-buffer']);
      expect(promptState.getState('pane-a').phase).toBe('draft_active');
    });

    it('defers when typing is injected after buffer prep for inactive', async () => {
      const { executor, promptState, service } = makeService();
      const forceSnapshot = promptState.getForceSnapshot('pane-a')!;
      const claimState = { phase: 'preparing' };
      const load = executor.holdInput('force-inactive-held');

      const guarded = service.deliverGuarded(
        { name: 'pane-a' },
        'force-inactive-held',
        { agentId: 'agent-a', confirm: false, postPasteDelayMs: 0 },
        undefined,
        makeForceFence(promptState, 'pane-a', forceSnapshot, claimState),
      );
      await load.started;

      promptState.recordPromptText('pane-a');
      load.release();

      await expect(guarded).resolves.toEqual({ deferred: 'human_draft' });
      expect(executor.calls.map((call) => call.argv[1])).toEqual(['load-buffer', 'delete-buffer']);
    });

    it('defers when executedInputEpoch changes after buffer prep', async () => {
      const { promptState, service } = makeService();
      const draft = promptState.recordPromptText('pane-a');
      promptState.transitionToAwaiting('pane-a', draft.generation);
      const forceSnapshot = promptState.getForceSnapshot('pane-a')!;
      const claimState = { phase: 'preparing' };

      promptState.recordExecutedInput('pane-a');

      await expect(
        service.deliverGuarded(
          { name: 'pane-a' },
          'force-epoch-changed',
          { agentId: 'agent-a', confirm: false, postPasteDelayMs: 0 },
          undefined,
          makeForceFence(promptState, 'pane-a', forceSnapshot, claimState),
        ),
      ).resolves.toEqual({ deferred: 'human_draft' });
    });

    it('succeeds despite meaningful output continuing (output epoch ignored)', async () => {
      const { promptState, service } = makeService();
      const draft = promptState.recordPromptText('pane-a');
      promptState.transitionToAwaiting('pane-a', draft.generation);
      const forceSnapshot = promptState.getForceSnapshot('pane-a')!;
      const claimState = { phase: 'preparing' };

      promptState.recordMeaningfulOutput('pane-a');
      promptState.recordMeaningfulOutput('pane-a');

      const result = await service.deliverGuarded(
        { name: 'pane-a' },
        'force-despite-output',
        { agentId: 'agent-a', confirm: false, postPasteDelayMs: 0 },
        undefined,
        makeForceFence(promptState, 'pane-a', forceSnapshot, claimState),
      );

      expect(result).toEqual(expect.objectContaining({ confirmed: true }));
      expect(promptState.getState('pane-a').phase).toBe('inactive');
    });

    it('applyForceDelivery runs once per claim even with retries', async () => {
      const { executor, promptState, service } = makeService();
      const draft = promptState.recordPromptText('pane-a');
      promptState.transitionToAwaiting('pane-a', draft.generation);
      const forceSnapshot = promptState.getForceSnapshot('pane-a')!;
      const claimState = { phase: 'preparing' };
      const applyForceSpy = jest.spyOn(promptState, 'applyForceDelivery');

      executor.onRun = (options) => {
        if (options.argv[1] === 'paste-buffer' && applyForceSpy.mock.calls.length === 1) {
          claimState.phase = 'mutating';
        }
      };

      const result = await service.deliverGuarded(
        { name: 'pane-a' },
        'force-once',
        { agentId: 'agent-a', confirm: false, postPasteDelayMs: 0, maxAttempts: 3 },
        undefined,
        makeForceFence(promptState, 'pane-a', forceSnapshot, claimState),
      );

      expect(result).toEqual(expect.objectContaining({ confirmed: true }));
      expect(applyForceSpy).toHaveBeenCalledTimes(1);
      expect(promptState.getState('pane-a').phase).toBe('inactive');
    });
  });

  it('blocks new writes during shutdown and settles existing tails before cleanup', async () => {
    const { executor, service } = makeService();
    executor.holdInput('in-flight');

    const inFlight = service.deliverImmediate({ name: 'pane-a' }, 'in-flight', immediateOptions);
    await settle();
    const shutdown = service.beforeApplicationShutdown();

    await expect(service.sendControl({ name: 'pane-a' }, ['Enter'])).rejects.toBeInstanceOf(
      TerminalIOClosingError,
    );
    expect(executor.calls.filter((call) => call.argv[1] === 'send-keys')).toHaveLength(0);

    executor.releaseInput('in-flight');
    await inFlight;
    await shutdown;

    const states = (service as unknown as { paneDeliveryStates: Map<string, unknown> })
      .paneDeliveryStates;
    expect(states.size).toBe(0);
  });
});
