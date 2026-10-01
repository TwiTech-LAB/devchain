import type { RemoteOperation } from '../../storage/models/domain.models';
import { DetachOperation } from './detach.operation';

function setup() {
  const fileSync = { flipBackToHost: jest.fn().mockResolvedValue(undefined) };
  const bindings = {
    get: jest.fn().mockResolvedValue({ remoteId: 'remote-1', state: 'detaching' }),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const liveSync = { start: jest.fn() };
  const host = { thaw: jest.fn().mockResolvedValue(undefined) };
  const copyBack = {
    partialGroups: jest.fn().mockResolvedValue([]),
    finish: jest.fn().mockResolvedValue(undefined),
    copyHome: jest.fn(),
  };
  const unused = {} as never;
  const detach = new DetachOperation(
    unused,
    bindings as never,
    unused,
    host as never,
    unused,
    liveSync as never,
    fileSync as never,
    unused,
    unused,
    copyBack as never,
  );
  return { detach, fileSync, bindings, liveSync, copyBack };
}
const operation = (
  steps: Array<{ id: string; state: string }>,
  details: Record<string, unknown>,
): RemoteOperation =>
  ({
    id: 'op-detach',
    kind: 'detach',
    remoteId: 'remote-1',
    projectId: 'A',
    state: 'failed',
    steps,
    details,
  }) as unknown as RemoteOperation;

describe('DetachOperation rollback', () => {
  it('unpauses the folders the final sync paused when it failed before its flip', async () => {
    const { detach, fileSync, bindings, liveSync } = setup();

    await detach.rollback(
      operation([{ id: 'file_sync_final', state: 'failed' }], {
        markedDetaching: true,
        fileSyncPaused: true,
      }),
    );

    expect(fileSync.flipBackToHost).toHaveBeenCalledWith('remote-1', 'A', false);
    expect(bindings.update).toHaveBeenCalledWith('A', { state: 'remote' });
    expect(liveSync.start).toHaveBeenCalledWith('A', 'remote-1', { full: true });
  });

  it('leaves the folders alone when neither the final sync nor the flip touched them', async () => {
    const { detach, fileSync } = setup();

    await detach.rollback(
      operation([{ id: 'final_pull', state: 'failed' }], { markedDetaching: true }),
    );

    expect(fileSync.flipBackToHost).not.toHaveBeenCalled();
  });
});

describe('DetachOperation Docker copy home', () => {
  const ids = (steps: readonly { id: string }[]) => steps.map((step) => step.id);

  it('has the copy step only when the Disconnect asked for it, after the VM stop', () => {
    const { detach } = setup();
    expect(ids(detach.stepsFor({ force: false }))).not.toContain('docker_copy_home');
    expect(ids(detach.stepsFor({ force: false }))).toEqual(
      ids(detach.steps).filter((id) => id !== 'docker_copy_home'),
    );
    const withCopy = ids(detach.stepsFor({ force: false, dockerCopyBack: { choices: {} } }));
    expect(withCopy.indexOf('docker_copy_home')).toBe(withCopy.indexOf('docker_stop_host') + 1);
    expect(withCopy.indexOf('docker_copy_home')).toBeLessThan(withCopy.indexOf('final_pull'));
  });

  it('skips the copy step on a forced disconnect and without the opt-in', () => {
    const { detach } = setup();
    const step = detach.steps.find((s) => s.id === 'docker_copy_home')!;
    expect(step.skip?.({ force: true, dockerCopyBack: { choices: {} } })).toBe(true);
    expect(step.skip?.({ force: false, dockerCopyBack: { choices: {} } })).toBe(false);
    expect(step.skip?.({ force: false })).toBe(true);
  });

  it('does nothing when a stored copy step runs without the opt-in', async () => {
    const { detach, copyBack } = setup();
    const step = detach.steps.find((s) => s.id === 'docker_copy_home')!;
    const details: Record<string, unknown> = { force: false };
    await step.run({
      operation: operation([{ id: 'docker_copy_home', state: 'running' }], details),
      details,
      progress: jest.fn(),
    });
    expect(copyBack.copyHome).not.toHaveBeenCalled();

    details.dockerCopyBack = { choices: {} };
    await step.run({
      operation: operation([{ id: 'docker_copy_home', state: 'running' }], details),
      details,
      progress: jest.fn(),
    });
    expect(copyBack.copyHome).toHaveBeenCalledTimes(1);
  });

  it('names the home groups a cancelled copy left incomplete, then drops the record', async () => {
    const { detach, copyBack, bindings } = setup();
    copyBack.partialGroups.mockResolvedValue(['app-db-1']);

    const result = await detach.rollback(
      operation([{ id: 'docker_copy_home', state: 'failed' }], { markedDetaching: true }),
    );

    expect(result).toEqual({ dockerCopyBackPartial: ['app-db-1'] });
    expect(bindings.update).toHaveBeenCalledWith('A', { state: 'remote' });
    expect(copyBack.finish).toHaveBeenCalledWith('op-detach');
  });

  it('keeps the copy record when giving the project back fails, so a second cancel still names it', async () => {
    const { detach, copyBack, bindings } = setup();
    copyBack.partialGroups.mockResolvedValue(['app-db-1']);
    bindings.update.mockRejectedValueOnce(new Error('storage down'));

    await expect(detach.rollback(operation([], { markedDetaching: true }))).rejects.toThrow(
      'storage down',
    );
    expect(copyBack.finish).not.toHaveBeenCalled();
  });
});

describe('DetachOperation preflight', () => {
  function preflightWith(health: Record<string, unknown>) {
    const bindings = {
      get: jest.fn().mockResolvedValue({ remoteId: 'remote-1', state: 'remote', hostCursor: null }),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const liveSync = { stop: jest.fn().mockResolvedValue(undefined) };
    const fileSync = { forcedLoss: jest.fn().mockResolvedValue(null) };
    const unused = {} as never;
    const detach = new DetachOperation(
      { getState: () => ({ online: true, versionMatches: true, ...health }) } as never,
      bindings as never,
      unused,
      unused,
      unused,
      liveSync as never,
      fileSync as never,
      unused,
      unused,
      unused,
    );
    const step = detach.steps.find((definition) => definition.id === 'preflight')!;
    return (details: Record<string, unknown>) =>
      step.run({ operation: operation([], details), details } as Parameters<typeof step.run>[0]);
  }

  it("refuses a VM that rejects this PC's API key unless the disconnect is forced", async () => {
    const run = preflightWith({ apiKeyRejected: true });

    await expect(run({})).rejects.toMatchObject({ code: 'HOST_API_KEY_REJECTED' });
    await expect(run({ force: true })).resolves.toBeUndefined();
  });
});
