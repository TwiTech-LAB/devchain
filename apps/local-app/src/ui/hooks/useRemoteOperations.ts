import { useMemo } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { useRemoteVmApi } from '@/ui/pages/cloud/lib/remote-vm-api-context';
import {
  REMOTES_LIST_QUERY_KEY,
  REMOTE_BINDINGS_QUERY_KEY,
  remoteOperationsKeys,
} from '@/ui/pages/cloud/lib/remote-vm-query-keys';
import type { WsEnvelope } from '@/ui/lib/socket';
import { useHomeSocket } from './useHomeSocket';
import type {
  RemoteOperationDto,
  SshCredentials,
  OperationAction,
} from '@/ui/pages/cloud/lib/remote-vm-contracts';

/** How many finished operations the Activity list shows. */
const RECENT_FINISHED_LIMIT = 20;

/**
 * Open work is loaded in full; finished work only as far as the Activity list
 * shows it. Row states never read finished operations: the VM list carries
 * what they need.
 */
const LIST_LIMITS = [
  ['running', 200],
  ['failed', 200],
  ['done', RECENT_FINISHED_LIMIT],
  ['cancelled', RECENT_FINISHED_LIMIT],
] as const;

/**
 * Step codes for which a failed host install can only continue with new SSH
 * credentials (including the sudo password) from the retry form; the plain
 * Retry button is hidden for exactly these codes.
 */
export const HOST_INSTALL_RETRY_FORM_CODES = [
  'SSH_CREDENTIALS_REQUIRED',
  'SSH_AUTH_FAILED',
  'SSH_KEY_INVALID',
  'SSH_SUDO_PASSWORD_REQUIRED',
] as const;

export function isHostInstallRetryFormCode(code: string | null | undefined): boolean {
  return (
    code !== null &&
    code !== undefined &&
    (HOST_INSTALL_RETRY_FORM_CODES as readonly string[]).includes(code)
  );
}

function scrubSshCredentials(credentials: SshCredentials): SshCredentials {
  return { user: credentials.user };
}

function scrubOperationCredentials(input: OperationAction): void {
  if (input.action === 'installHost') {
    input.body.ssh = scrubSshCredentials(input.body.ssh);
  } else if (input.action === 'retry' && input.ssh) {
    input.ssh = scrubSshCredentials(input.ssh);
  }
}

export function useRemoteOperations() {
  const api = useRemoteVmApi();
  const client = useHomeQueryClient();
  const query = useQuery(
    {
      queryKey: remoteOperationsKeys.all,
      queryFn: async ({ signal }) => {
        const lists = await Promise.all(
          LIST_LIMITS.map(([state, limit]) => api.listOperations(state, limit, signal)),
        );
        return Array.from(
          new Map(lists.flat().map((operation) => [operation.id, operation])).values(),
        );
      },
      refetchInterval: 10_000,
    },
    client,
  );

  const refresh = () => {
    void client.invalidateQueries({ queryKey: remoteOperationsKeys.all });
    void client.invalidateQueries({ queryKey: REMOTE_BINDINGS_QUERY_KEY });
  };
  useHomeSocket(
    {
      connect: refresh,
      message: (envelope: unknown) => {
        const { topic, type, payload } = (envelope ?? {}) as Partial<WsEnvelope>;
        if (topic !== 'remote-operations' || type !== 'progress') return;
        if (!isOperation(payload)) return refresh();
        // Step progress arrives about once a second; it must cost no request.
        const previous = client
          .getQueryData<RemoteOperationDto[]>(remoteOperationsKeys.all)
          ?.find((item) => item.id === payload.id);
        client.setQueryData<RemoteOperationDto[]>(remoteOperationsKeys.all, (current = []) =>
          previous
            ? current.map((item) => (item.id === payload.id ? payload : item))
            : [payload, ...current],
        );
        // The VM list carries each VM's newest operation and recorded logins.
        if (previous?.state !== payload.state) {
          void client.invalidateQueries({ queryKey: REMOTE_BINDINGS_QUERY_KEY });
          void client.invalidateQueries({ queryKey: REMOTES_LIST_QUERY_KEY });
          // A finished Connect or Disconnect records its cleanup error only in
          // the project's newest-operation query.
          if (payload.projectId) {
            void client.invalidateQueries({
              queryKey: remoteOperationsKeys.newestOfProject(payload.projectId),
            });
          }
        }
        if (['create_vm', 'reset_vm', 'destroy_vm'].includes(payload.kind)) {
          const remoteChangingSteps =
            payload.kind === 'create_vm'
              ? ['wait_ip']
              : payload.kind === 'reset_vm'
                ? ['destroy', 'create_wait_ip']
                : ['destroy'];
          const changedRemoteStep = payload.steps.some((step) => {
            if (!remoteChangingSteps.includes(step.id) || step.state !== 'done') return false;
            return previous?.steps.find((oldStep) => oldStep.id === step.id)?.state !== 'done';
          });
          if (changedRemoteStep) {
            void client.invalidateQueries({ queryKey: REMOTES_LIST_QUERY_KEY });
          }
        }
      },
    },
    [client],
  );

  const action = useMutation(
    {
      mutationFn: (input: OperationAction) => {
        switch (input.action) {
          case 'forceSync':
            return api.forceSync(input.remoteId, {
              projectId: input.projectId,
              source: input.source,
            });
          case 'installHost': {
            const body = { ...input.body, ssh: { ...input.body.ssh } };
            scrubOperationCredentials(input);
            return api.installHost(body);
          }
          case 'claim':
            return api.claimHost(input.body);
          case 'createVm':
            return api.createVm(input.connectionId, input.body);
          case 'resetVm':
            return api.resetVm(input.remoteId, input.body);
          case 'destroyVm':
            return api.destroyVm(input.remoteId, input.body);
          case 'updateLogins':
            return api.updateLogins(input.remoteId, input.body);
          case 'retry': {
            const body = {
              ...(input.providerAuth ? { providerAuth: input.providerAuth } : {}),
              ...(input.ssh ? { ssh: { ...input.ssh } } : {}),
            };
            scrubOperationCredentials(input);
            return api.retryOperation(input.operationId, body);
          }
          case 'cancel':
            return api.cancelOperation(input.operationId);
          case 'attach':
            return api.attachProject(input.remoteId, {
              projectId: input.projectId,
              docker: input.docker,
            });
          case 'detach':
            return api.detachProject(input.remoteId, {
              projectId: input.projectId,
              force: input.force,
              dockerCopyBack: input.dockerCopyBack,
            });
          case 'updateHost':
            return api.updateHost(
              input.remoteId,
              input.installDocker ? { installDocker: true } : undefined,
            );
        }
      },
      onSuccess: (operation) => {
        client.setQueryData<RemoteOperationDto[]>(remoteOperationsKeys.all, (current = []) => [
          operation,
          ...current.filter((item) => item.id !== operation.id),
        ]);
        refresh();
        void client.invalidateQueries({ queryKey: REMOTES_LIST_QUERY_KEY });
      },
      // No toast here: each caller shows the error where the request started.
      onSettled: (_operation, _error, variables) => scrubOperationCredentials(variables),
    },
    client,
  );

  const operations = useMemo(() => query.data ?? [], [query.data]);
  const recentFinished = useMemo(
    () =>
      operations
        .filter((operation) => operation.state === 'done' || operation.state === 'cancelled')
        .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
        .slice(0, RECENT_FINISHED_LIMIT),
    [operations],
  );

  return {
    operations,
    recentFinished,
    loading: query.isLoading,
    error: query.error,
    action,
    refresh,
  };
}

function isOperation(value: unknown): value is RemoteOperationDto {
  const row = value as Partial<RemoteOperationDto> | null;
  return typeof row?.id === 'string' && typeof row.state === 'string' && Array.isArray(row.steps);
}
