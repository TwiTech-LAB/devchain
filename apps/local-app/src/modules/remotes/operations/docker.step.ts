import { RemoteHostClient, RemoteHostRequestError } from './remote-host.client';
import { RemoteOperationStepRefusedError } from './remote-operation.errors';
import { sleep, type RemoteOperationTiming } from './remote-operation.timing';
import type { RemoteOperationStepDefinition } from './remote-operation.types';

export function dockerStep(
  host: RemoteHostClient,
  timing: RemoteOperationTiming,
): RemoteOperationStepDefinition {
  return {
    id: 'docker',
    label: 'Install Docker Engine and Compose',
    skip: (details) => details.installDocker !== true,
    async run({ operation, details, progress }) {
      // Composed claim operations may omit skip; the persisted choice is authoritative.
      if (details.installDocker !== true) return;
      const remoteId = operation.remoteId;
      const before = await host.remoteRuntime(remoteId).catch(() => null);
      if (before?.docker?.installed && before.docker.userInGroup) return;
      const previousBoot =
        typeof details.dockerBootId === 'string' ? details.dockerBootId : before?.bootId;
      await progress({ dockerBootId: previousBoot ?? null });
      const previousStatus = await host.dockerStatus(remoteId).catch(() => null);
      let jobId: string | null = null;
      try {
        jobId = (await host.requestDocker(remoteId)).jobId;
      } catch (error) {
        if (
          error instanceof RemoteHostRequestError &&
          error.details?.hostCode === 'HOST_HELPER_OUTDATED'
        ) {
          throw new RemoteOperationStepRefusedError('HOST_HELPER_OUTDATED', error.message);
        }
        // A lost reply is ambiguous: the detached worker may already be installing.
        if (!(error instanceof RemoteHostRequestError) || error.status !== null) throw error;
      }
      const deadline = Date.now() + timing.hostUpdateTimeoutMs;
      for (;;) {
        const status = await host.dockerStatus(remoteId).catch(() => null);
        const current =
          status &&
          (jobId
            ? status.jobId === jobId
            : status.jobId !== previousStatus?.jobId ||
              ['installing', 'restarting'].includes(previousStatus?.state ?? ''));
        if (current && status.state === 'failed') {
          throw new RemoteOperationStepRefusedError(
            status.code ?? 'DOCKER_INSTALL_FAILED',
            status.error ?? 'Docker installation failed.',
          );
        }
        if (current && status.state === 'done') {
          const runtime = await host.remoteRuntime(remoteId).catch(() => null);
          if (
            runtime?.docker?.installed &&
            runtime.docker.userInGroup &&
            (!previousBoot || runtime.bootId !== previousBoot)
          )
            return;
        }
        if (Date.now() >= deadline)
          throw new RemoteOperationStepRefusedError(
            'DOCKER_INSTALL_TIMEOUT',
            'Docker did not become usable after the host restart; retry.',
          );
        await sleep(timing.pollIntervalMs);
      }
    },
  };
}
