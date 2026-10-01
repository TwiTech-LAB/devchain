// Unit layer controls ambiguous responses and process identity without real installs or timers.
import { dockerStep } from './docker.step';
import { RemoteHostRequestError, type RemoteHostClient } from './remote-host.client';
import { DEFAULT_REMOTE_OPERATION_TIMING } from './remote-operation.timing';
import type { RemoteOperationStepRun } from './remote-operation.types';

const usable = {
  installed: true,
  userInGroup: true,
  engineVersion: '29',
  composeVersion: '2',
  dataRootFreeBytes: 1,
};
function fixture() {
  const host = {
    remoteRuntime: jest
      .fn()
      .mockResolvedValue({ bootId: 'before', docker: { ...usable, installed: false } }),
    requestDocker: jest.fn().mockResolvedValue({ jobId: 'new' }),
    dockerStatus: jest.fn().mockResolvedValue({ jobId: 'new', state: 'done' }),
  };
  const details: Record<string, unknown> = { installDocker: true };
  const run = {
    operation: { remoteId: 'remote' },
    details,
    progress: jest.fn(async (patch) => {
      Object.assign(details, patch);
    }),
  } as unknown as RemoteOperationStepRun;
  const step = dockerStep(host as unknown as RemoteHostClient, {
    ...DEFAULT_REMOTE_OPERATION_TIMING,
    pollIntervalMs: 1,
    hostUpdateTimeoutMs: 40,
  });
  return { host, run, step };
}

it('does nothing when a composed claim loses skip but the option is off', async () => {
  const { host, run, step } = fixture();
  run.details.installDocker = false;
  await step.run(run);
  expect(host.requestDocker).not.toHaveBeenCalled();
  expect(host.remoteRuntime).not.toHaveBeenCalled();
});

it('waits for the restarted process and group access after the job completes', async () => {
  const { host, run, step } = fixture();
  host.remoteRuntime
    .mockResolvedValueOnce({ bootId: 'before' })
    .mockResolvedValueOnce({ bootId: 'before', docker: usable })
    .mockResolvedValueOnce({ bootId: 'after', docker: { ...usable, userInGroup: false } })
    .mockResolvedValue({ bootId: 'after', docker: usable });
  await step.run(run);
  expect(host.remoteRuntime).toHaveBeenCalledTimes(4);
});

it('recovers a lost request response and ignores the preceding failed attempt', async () => {
  const { host, run, step } = fixture();
  host.requestDocker.mockRejectedValue(
    new RemoteHostRequestError('lost', {
      remoteId: 'remote',
      path: '/api/host/docker',
      status: null,
      hostCode: null,
    }),
  );
  host.dockerStatus
    .mockResolvedValueOnce({ jobId: 'old', state: 'failed' })
    .mockResolvedValueOnce({ jobId: 'old', state: 'failed' })
    .mockResolvedValue({ jobId: 'new', state: 'done' });
  host.remoteRuntime
    .mockResolvedValueOnce({ bootId: 'before' })
    .mockResolvedValue({ bootId: 'after', docker: usable });
  await step.run(run);
  expect(host.requestDocker).toHaveBeenCalledTimes(1);
});

it('surfaces a current apt failure and a retry can finish', async () => {
  const { host, run, step } = fixture();
  host.dockerStatus.mockResolvedValue({ jobId: 'new', state: 'failed', error: 'apt failed' });
  await expect(step.run(run)).rejects.toThrow('apt failed');
  host.dockerStatus.mockResolvedValue({ jobId: 'new', state: 'done' });
  host.remoteRuntime
    .mockResolvedValueOnce({ bootId: 'before' })
    .mockResolvedValue({ bootId: 'after', docker: usable });
  await expect(step.run(run)).resolves.toBeUndefined();
});

it('times out instead of treating an unchanged boot as success', async () => {
  const { host, run, step } = fixture();
  host.remoteRuntime
    .mockResolvedValueOnce({ bootId: 'before' })
    .mockResolvedValue({ bootId: 'before', docker: usable });
  await expect(step.run(run)).rejects.toMatchObject({ code: 'DOCKER_INSTALL_TIMEOUT' });
});
