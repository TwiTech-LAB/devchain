import { useMemo } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ForceSyncSource } from '@/modules/remotes/operations/remote-operation.dto';
import type { DockerSelection } from '@/modules/remotes/docker/docker-plan.dto';
import type { DockerCopyBackRequest } from '@/modules/remotes/docker/docker-copy-back.dto';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { HOME_BACKEND, apiFetch } from '@/ui/lib/api-transport';
import { REMOTES_LIST_QUERY_KEY, REMOTE_BINDINGS_QUERY_KEY } from '@/ui/lib/backend-provider';
import type { WsEnvelope } from '@/ui/lib/socket';
import { useHomeSocket } from './useHomeSocket';

export interface RemoteOperationDto {
  id: string;
  kind: string;
  remoteId: string;
  projectId: string | null;
  state: 'running' | 'failed' | 'done' | 'cancelled';
  steps: {
    id: string;
    label: string;
    state: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
    startedAt?: string | null;
    error: { message: string; code: string | null } | null;
  }[];
  details: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export const remoteOperationsKeys = {
  all: [HOME_BACKEND, 'remote-operations'] as const,
  /** One project's newest operation; under `all`, so any operations refresh reloads it. */
  newestOfProject: (projectId: string) => [...remoteOperationsKeys.all, 'newest', projectId],
};

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init, { backend: HOME_BACKEND });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.message ?? `Remote operation request failed (${response.status})`);
  }
  return response.json();
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function jsonPost(body?: unknown): RequestInit {
  if (body === undefined) return { method: 'POST' };
  return { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) };
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

export interface ClaimRequestBody {
  remoteId?: string;
  baseUrl?: string;
  /** Read on the VM; required with `baseUrl`. */
  certificateFingerprint?: string;
  name?: string;
  port?: number;
  /** `reuse:<entryId>`, `generate` or `skip`, per provider. */
  providerAuth: Record<string, string>;
  installDocker?: boolean;
  sshPublicKeys?: string[];
}

export interface SshCredentials {
  user: string;
  password?: string;
  privateKey?: string;
  keyName?: string;
  passphrase?: string;
  sudoPassword?: string;
}

export interface InstallHostRequestBody {
  address: string;
  ssh: SshCredentials;
  name?: string;
  providerAuth: Record<string, string>;
  installDocker?: boolean;
  sshPublicKeys?: string[];
  minDiskGib: number;
}

export interface ResetVmRequestBody {
  force: boolean;
  providerAuth: Record<string, string>;
  installDocker?: boolean;
  sshPublicKeys?: string[];
}

/** Change-logins body: only the changed providers, `skip` meaning "remove". */
export interface UpdateLoginsRequestBody {
  providerAuth: Record<string, string>;
  force: boolean;
}

export type OperationAction =
  | {
      action: 'attach' | 'detach';
      remoteId: string;
      projectId: string;
      force?: boolean;
      /** The Docker items a Connect carries: plan item ids with their chosen modes. */
      docker?: DockerSelection;
      /** A Disconnect's "Copy Docker data back to this PC", with its choices. */
      dockerCopyBack?: DockerCopyBackRequest;
    }
  | { action: 'forceSync'; remoteId: string; projectId: string; source: ForceSyncSource }
  | { action: 'updateHost'; remoteId: string; installDocker?: true }
  | {
      action: 'createVm';
      connectionId: string;
      body: ClaimRequestBody & { name: string; cores: number; memory: number; disk: number };
    }
  | { action: 'installHost'; body: InstallHostRequestBody }
  | { action: 'resetVm'; remoteId: string; body: ResetVmRequestBody }
  | { action: 'destroyVm'; remoteId: string; body: { force: boolean } }
  | { action: 'updateLogins'; remoteId: string; body: UpdateLoginsRequestBody }
  | { action: 'claim'; body: ClaimRequestBody }
  | {
      action: 'retry';
      operationId: string;
      providerAuth?: Record<string, string>;
      ssh?: SshCredentials;
    }
  | { action: 'cancel'; operationId: string };

export function useRemoteOperations() {
  const client = useHomeQueryClient();
  const query = useQuery(
    {
      queryKey: remoteOperationsKeys.all,
      queryFn: async ({ signal }) => {
        const lists = await Promise.all(
          LIST_LIMITS.map(([state, limit]) =>
            request<{ items: RemoteOperationDto[] }>(
              `/api/remotes/operations?state=${state}&limit=${limit}`,
              { signal },
            ),
          ),
        );
        return Array.from(
          new Map(
            lists.flatMap((list) => list.items ?? []).map((operation) => [operation.id, operation]),
          ).values(),
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
        if (input.action === 'forceSync') {
          return request<RemoteOperationDto>(
            `/api/remotes/${input.remoteId}/force-sync`,
            jsonPost({ projectId: input.projectId, source: input.source }),
          );
        }
        if (input.action === 'installHost') {
          const init = jsonPost(input.body);
          scrubOperationCredentials(input);
          return request<RemoteOperationDto>('/api/remotes/host-install', init);
        }
        if (input.action === 'claim') {
          return request<RemoteOperationDto>('/api/remotes/claim', jsonPost(input.body));
        }
        if (input.action === 'createVm') {
          return request<RemoteOperationDto>(
            `/api/vm-providers/${input.connectionId}/create-vm`,
            jsonPost(input.body),
          );
        }
        if (input.action === 'resetVm') {
          return request<RemoteOperationDto>(
            `/api/remotes/${input.remoteId}/reset`,
            jsonPost(input.body),
          );
        }
        if (input.action === 'destroyVm') {
          return request<RemoteOperationDto>(
            `/api/remotes/${input.remoteId}/destroy-vm`,
            jsonPost(input.body),
          );
        }
        if (input.action === 'updateLogins') {
          return request<RemoteOperationDto>(
            `/api/remotes/${input.remoteId}/logins`,
            jsonPost(input.body),
          );
        }
        if ('operationId' in input) {
          const body = {
            ...('providerAuth' in input && input.providerAuth
              ? { providerAuth: input.providerAuth }
              : {}),
            ...('ssh' in input && input.ssh ? { ssh: input.ssh } : {}),
          };
          const init = jsonPost(Object.keys(body).length > 0 ? body : undefined);
          scrubOperationCredentials(input);
          return request<RemoteOperationDto>(
            `/api/remotes/operations/${input.operationId}/${input.action}`,
            init,
          );
        }
        const segment = input.action === 'updateHost' ? 'update' : input.action;
        const body =
          'projectId' in input
            ? {
                projectId: input.projectId,
                ...(input.action === 'detach' && { force: input.force ?? false }),
                ...(input.action === 'detach' &&
                  input.dockerCopyBack && { dockerCopyBack: input.dockerCopyBack }),
                ...(input.action === 'attach' && input.docker && { docker: input.docker }),
              }
            : input.action === 'updateHost' && input.installDocker
              ? { installDocker: true }
              : undefined;
        return request<RemoteOperationDto>(
          `/api/remotes/${input.remoteId}/${segment}`,
          jsonPost(body),
        );
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
