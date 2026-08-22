import type { EventsService } from '../../../events/services/events.service';
import { FakeProcessExecutor } from '../process-executor/fake-process-executor';
import { TerminalIOService } from './terminal-io.service';
import { HumanPromptStateService } from '../human-prompt-state.service';

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
  let executor: FakeProcessExecutor;
  let events: { publish: jest.Mock };
  let service: TerminalIOService;
  let humanPromptState: HumanPromptStateService;

  beforeEach(() => {
    jest.useFakeTimers();
    executor = new FakeProcessExecutor();
    events = { publish: jest.fn().mockResolvedValue('event-id') };
    humanPromptState = new HumanPromptStateService();
    service = new TerminalIOService(executor, events as unknown as EventsService, humanPromptState);
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
});
