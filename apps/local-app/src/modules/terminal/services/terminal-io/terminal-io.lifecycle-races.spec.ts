import type { EventsService } from '../../../events/services/events.service';
import type { SettingsService } from '../../../settings/services/settings.service';
import { CliForegroundExecutor } from '../process-executor/fake-process-executor';
import { TerminalIOService } from './terminal-io.service';
import { HumanPromptStateService } from '../human-prompt-state.service';
import type { ExecutorResult } from '../process-executor/process-executor.port';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

describe('TerminalIOService lifecycle monitoring', () => {
  let executor: CliForegroundExecutor;
  let events: { publish: jest.Mock };
  let service: TerminalIOService;
  let humanPromptState: HumanPromptStateService;

  beforeEach(() => {
    jest.useFakeTimers();
    executor = new CliForegroundExecutor();
    events = { publish: jest.fn().mockResolvedValue('event-id') };
    humanPromptState = new HumanPromptStateService();
    const settings = { getFollowNoteEnabled: () => true } as unknown as SettingsService;
    service = new TerminalIOService(
      executor,
      events as unknown as EventsService,
      humanPromptState,
      settings,
    );
  });

  afterEach(() => {
    service.beforeApplicationShutdown();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each([`can't find session: exact-name`, 'no server running on /tmp/tmux-1000/default'])(
    'classifies only authoritative tmux absence: %s',
    async (stderr) => {
      humanPromptState.recordPromptText('exact-name');
      executor.enqueueResponse({ type: 'failure', stderr });

      await expect(
        service.destroyExpectedSession({ name: 'exact-name' }, { onUnknownError: 'retire' }),
      ).resolves.toEqual({ outcome: 'known-absent' });
      expect(humanPromptState.getState('exact-name').phase).toBe('inactive');
    },
  );

  it.each([
    { type: 'failure' as const, stderr: 'permission denied' },
    { type: 'failure' as const, stderr: `can't find session: another-name` },
    { type: 'timeout' as const },
  ])('keeps ambiguous destroy failures unknown: $type $stderr', async (response) => {
    executor.enqueueResponse(response);

    const result = await service.destroyExpectedSession(
      { name: 'exact-name' },
      { onUnknownError: 'retire' },
    );

    expect(result.outcome).toBe('unknown-error');
  });

  it('treats a truncated failure as unknown even when its prefix resembles absence', async () => {
    jest.spyOn(executor, 'run').mockResolvedValueOnce({
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: `can't find session: exact-name`,
      timedOut: false,
      truncated: true,
    });

    const result = await service.destroyExpectedSession(
      { name: 'exact-name' },
      { onUnknownError: 'retire' },
    );

    expect(result.outcome).toBe('unknown-error');
  });

  it('suppresses a deferred dead callback after expected teardown wins', async () => {
    const probe = deferred<{ alive: boolean }>();
    jest.spyOn(service, 'healthCheck').mockReturnValueOnce(probe.promise);
    executor.enqueueResponse({ type: 'success' });
    service.startHealthCheck('tmux-a', 'session-a', 10);

    jest.advanceTimersByTime(10);
    await settle();
    await expect(
      service.destroyExpectedSession(
        { name: 'tmux-a' },
        { onUnknownError: 'rearm', sessionId: 'session-a' },
      ),
    ).resolves.toEqual({ outcome: 'destroyed' });

    probe.resolve({ alive: false });
    await settle();
    jest.advanceTimersByTime(100);
    await settle();

    expect(events.publish).not.toHaveBeenCalled();
    expect(service.healthCheck).toHaveBeenCalledTimes(1);
  });

  it('finishes crash publication before an already-requested destroy runs', async () => {
    const publication = deferred<string>();
    jest.spyOn(service, 'healthCheck').mockResolvedValue({ alive: false });
    events.publish.mockReturnValueOnce(publication.promise);
    executor.enqueueResponse({ type: 'success' });
    service.startHealthCheck('tmux-b', 'session-b', 10);

    jest.advanceTimersByTime(10);
    await settle();
    expect(events.publish).toHaveBeenCalledTimes(1);

    const destroy = service.destroyExpectedSession(
      { name: 'tmux-b' },
      { onUnknownError: 'rearm', sessionId: 'session-b' },
    );
    await settle();
    expect(executor.calls).toHaveLength(0);

    publication.resolve('event-id');
    await expect(destroy).resolves.toEqual({ outcome: 'destroyed' });
    expect(executor.calls[0].argv).toEqual(['tmux', 'kill-session', '-t', '=tmux-b']);
  });

  it('does not let a replaced monitor callback retire or publish for its newer owner', async () => {
    const oldProbe = deferred<{ alive: boolean }>();
    jest
      .spyOn(service, 'healthCheck')
      .mockReturnValueOnce(oldProbe.promise)
      .mockResolvedValueOnce({ alive: false });
    service.startHealthCheck('tmux-c', 'old-session', 10);
    jest.advanceTimersByTime(10);
    await settle();

    service.startHealthCheck('tmux-c', 'new-session', 10);
    oldProbe.resolve({ alive: false });
    await settle();
    expect(events.publish).not.toHaveBeenCalled();

    jest.advanceTimersByTime(10);
    await settle();
    expect(events.publish).toHaveBeenCalledTimes(1);
    expect(events.publish).toHaveBeenCalledWith('session.crashed', {
      sessionId: 'new-session',
      sessionName: 'tmux-c',
    });
  });

  it('rearms with a fresh identity after publication failure and retires after retry success', async () => {
    jest.spyOn(service, 'healthCheck').mockResolvedValue({ alive: false });
    events.publish
      .mockRejectedValueOnce(new Error('event store unavailable'))
      .mockResolvedValueOnce('event-id');
    service.startHealthCheck('tmux-d', 'session-d', 10);

    jest.advanceTimersByTime(10);
    await settle();
    expect(events.publish).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(10);
    await settle();
    expect(events.publish).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(100);
    await settle();
    expect(events.publish).toHaveBeenCalledTimes(2);
  });

  it('rearms only the running-session policy after an unknown kill result', async () => {
    jest.spyOn(service, 'healthCheck').mockResolvedValue({ alive: true });
    service.startHealthCheck('tmux-e', 'session-e', 10);
    humanPromptState.recordPromptText('tmux-e');
    executor.enqueueResponse({ type: 'failure', stderr: 'permission denied' });

    const result = await service.destroyExpectedSession(
      { name: 'tmux-e' },
      { onUnknownError: 'rearm', sessionId: 'session-e' },
    );
    expect(result.outcome).toBe('unknown-error');
    expect(humanPromptState.getState('tmux-e').phase).toBe('draft_active');

    jest.advanceTimersByTime(10);
    await settle();
    expect(service.healthCheck).toHaveBeenCalledTimes(1);
  });

  it('never rearms rollback cleanup after an unknown kill result', async () => {
    jest.spyOn(service, 'healthCheck').mockResolvedValue({ alive: true });
    service.startHealthCheck('tmux-f', 'session-f', 10);
    humanPromptState.recordPromptText('tmux-f');
    executor.enqueueResponse({ type: 'failure', stderr: 'permission denied' });

    const result = await service.destroyExpectedSession(
      { name: 'tmux-f' },
      { onUnknownError: 'retire' },
    );
    expect(result.outcome).toBe('unknown-error');
    expect(humanPromptState.getState('tmux-f').phase).toBe('inactive');

    jest.advanceTimersByTime(100);
    await settle();
    expect(service.healthCheck).not.toHaveBeenCalled();
  });

  // Fake timers and argv-routed process results exercise monitor races without a tmux daemon.
  describe('CLI exit detection', () => {
    const sessionName = 'cli-pane';
    const sessionId = 'cli-session';
    const success: ExecutorResult = {
      success: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      truncated: false,
    };

    async function tick(count = 1): Promise<void> {
      for (let index = 0; index < count; index += 1) {
        await jest.advanceTimersByTimeAsync(10);
      }
    }

    async function observeCli(): Promise<void> {
      service.startHealthCheck(sessionName, sessionId, 10);
      await tick();
      executor.foregroundGroup = '1234';
    }

    function kills() {
      return executor.calls.filter((call) => call.argv[1] === 'kill-session');
    }

    it('destroys the exact session and publishes once after three shell ticks', async () => {
      await observeCli();
      humanPromptState.recordPromptText(sessionName);
      executor.processStates = '1234 S\n4321 T+\n';
      await tick(2);
      expect(kills()).toHaveLength(0);
      expect(events.publish).not.toHaveBeenCalled();

      await tick();
      expect(kills().map((call) => call.argv)).toEqual([
        ['tmux', 'kill-session', '-t', '=cli-pane'],
      ]);
      expect(events.publish).toHaveBeenCalledTimes(1);
      expect(events.publish).toHaveBeenCalledWith('session.crashed', {
        sessionId,
        sessionName,
      });
      expect(humanPromptState.getState(sessionName).phase).toBe('inactive');
      await tick(5);
      expect(events.publish).toHaveBeenCalledTimes(1);
    });

    it('leaves a pane alone when its CLI was never observed', async () => {
      executor.foregroundGroup = '1234';
      service.startHealthCheck(sessionName, sessionId, 10);
      await tick(5);
      expect(kills()).toHaveLength(0);
      expect(events.publish).not.toHaveBeenCalled();
    });

    it('resets shell ticks while a stopped child protects a suspended CLI', async () => {
      await observeCli();
      await tick(2);
      executor.processStates = '0 Ss\n1234 T+\n1234 S\n';
      await tick(5);
      expect(kills()).toHaveLength(0);
      expect(events.publish).not.toHaveBeenCalled();
      executor.processStates = '1 S\n';
      await tick(2);
      expect(kills()).toHaveLength(0);
      await tick();
      expect(events.publish).toHaveBeenCalledTimes(1);
    });

    it('requires consecutive shell ticks after a transient shell reading', async () => {
      await observeCli();
      await tick();
      executor.foregroundGroup = '2345';
      await tick();
      executor.foregroundGroup = '1234';
      await tick(2);
      expect(kills()).toHaveLength(0);
      expect(events.publish).not.toHaveBeenCalled();
      await tick();
      expect(events.publish).toHaveBeenCalledTimes(1);
    });

    it.each(['pane PID', 'foreground group', 'process states'])(
      'resets the grace window for failed, timed-out, invalid or thrown %s reads',
      async (read) => {
        const unknowns = [
          { ...success, success: false, exitCode: 1 },
          { ...success, timedOut: true },
          { ...success, stdout: 'invalid' },
          { ...success, stdout: '1234', truncated: true },
          new Error('spawn failed'),
        ];
        await observeCli();
        for (const unknown of unknowns) {
          await tick(2);
          const run = executor.run.bind(executor);
          let intercepted = false;
          const spy = jest.spyOn(executor, 'run').mockImplementation(async (options) => {
            const matches =
              read === 'pane PID'
                ? options.argv[1] === 'display-message'
                : read === 'foreground group'
                  ? options.argv[2] === 'tpgid='
                  : options.argv[3] === 'ppid=,stat=';
            if (!intercepted && matches) {
              intercepted = true;
              if (unknown instanceof Error) throw unknown;
              return unknown;
            }
            return run(options);
          });
          await tick();
          spy.mockRestore();
          expect(intercepted).toBe(true);
          expect(kills()).toHaveLength(0);
          expect(events.publish).not.toHaveBeenCalled();
        }
        await tick(2);
        expect(kills()).toHaveLength(0);
        await tick();
        expect(events.publish).toHaveBeenCalledTimes(1);
      },
    );

    it.each(['destroy', 'replace'])(
      'suppresses an exit callback when %s wins a deferred foreground probe',
      async (operation) => {
        await observeCli();
        await tick(2);
        const probe = deferred<ExecutorResult>();
        const run = executor.run.bind(executor);
        jest
          .spyOn(executor, 'run')
          .mockImplementation((options) =>
            options.argv[3] === 'ppid=,stat=' ? probe.promise : run(options),
          );
        await tick();

        if (operation === 'destroy') {
          await service.destroyExpectedSession(
            { name: sessionName },
            { onUnknownError: 'rearm', sessionId },
          );
        } else {
          service.startHealthCheck(sessionName, 'replacement-session', 10);
        }
        probe.resolve({ ...success, stdout: '1 S\n' });
        await settle();
        await tick(4);
        expect(events.publish).not.toHaveBeenCalled();
        expect(kills()).toHaveLength(operation === 'destroy' ? 1 : 0);
      },
    );

    it('rearms after an unknown exit destroy without clearing prompt state or publishing', async () => {
      await observeCli();
      humanPromptState.recordPromptText(sessionName);
      await tick(2);
      executor.enqueueResponse(
        { type: 'success' },
        { type: 'failure', stderr: 'permission denied' },
      );
      await tick();
      expect(kills()).toHaveLength(1);
      expect(events.publish).not.toHaveBeenCalled();
      expect(humanPromptState.getState(sessionName).phase).toBe('draft_active');
      await tick(2);
      expect(kills()).toHaveLength(1);
      await tick();
      expect(kills()).toHaveLength(2);
      expect(events.publish).toHaveBeenCalledTimes(1);
    });

    it('rearms after exit crash publication fails and retries on confirmed tmux loss', async () => {
      await observeCli();
      events.publish.mockRejectedValueOnce(new Error('event store unavailable'));
      await tick(3);
      expect(kills()).toHaveLength(1);
      expect(events.publish).toHaveBeenCalledTimes(1);
      executor.enqueueResponse({ type: 'failure', stderr: `can't find session: ${sessionName}` });
      await tick();
      expect(events.publish).toHaveBeenCalledTimes(2);
      await tick(5);
      expect(events.publish).toHaveBeenCalledTimes(2);
    });

    it('requires a fresh foreground observation after a monitor restarts', async () => {
      await observeCli();
      service.stopHealthCheck(sessionName);
      service.startHealthCheck(sessionName, sessionId, 10);
      await tick(5);
      expect(kills()).toHaveLength(0);
      expect(events.publish).not.toHaveBeenCalled();
      executor.foregroundGroup = '2345';
      await tick();
      executor.foregroundGroup = '1234';
      await tick(3);
      expect(events.publish).toHaveBeenCalledTimes(1);
    });
  });
});
