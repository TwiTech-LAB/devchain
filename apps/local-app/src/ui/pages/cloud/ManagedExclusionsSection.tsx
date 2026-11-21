import { useId, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  ManagedExclusionReason,
  ManagedExclusionRow,
} from '@/modules/remotes/sync/remote-file-sync.dto';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { BusyStatus } from '@/ui/components/ui/spinner';
import { useRemoteVmApi } from './lib/remote-vm-api-context';
import { managedExclusionsQueryKey } from './lib/remote-vm-query-keys';

const sideLabels = { home: 'this PC', vm: 'the VM' };

const uncheckedReasons: Partial<Record<string, string>> = {
  'not-connected': 'The project is not connected.',
  offline: 'The VM is offline.',
  'api-key-rejected': 'The VM rejected the API key.',
  'version-mismatch': 'The VM needs an update.',
  'invalid-path': 'The folder path is invalid.',
  'home-mounts-unavailable': 'Could not read Docker mounts on this PC.',
  'vm-mounts-unavailable': 'Could not read Docker mounts on the VM.',
  'compose-mounts-unavailable': 'Could not read mounts from the Compose file.',
  'home-inspection-unavailable': 'Could not check file owners on this PC.',
  'vm-inspection-unavailable': 'Could not check file owners on the VM.',
  'home-inspection-incomplete': 'The file owner check on this PC was incomplete.',
  'vm-inspection-incomplete': 'The file owner check on the VM was incomplete.',
  'retained-descendant': 'A Docker data folder inside this one still needs its exclusion.',
};

function describeReason(reason: ManagedExclusionReason) {
  switch (reason.kind) {
    case 'docker':
      return reason.side === 'compose'
        ? `The Compose service ${reason.name} mounts it in the Compose file.`
        : `The container ${reason.name} mounts it on ${sideLabels[reason.side]}.`;
    case 'permissions':
      return `Files on ${sideLabels[reason.side]} are owned by ${reason.owners.join(', ')}.`;
    case 'covered':
      return `The Docker data folder ${reason.by} already excludes it.`;
    case 'unchecked':
      return uncheckedReasons[reason.cause] ?? 'The folder could not be checked.';
  }
}

function describeExclusion(row: ManagedExclusionRow, removalTime: string): ReactNode {
  if (row.status === 'stays') return <>Stays out of file sync. {describeReason(row.reason)}</>;
  if (row.remainingRule)
    return (
      <>
        The Docker exclusion is removed {removalTime}. The rule <code>{row.remainingRule}</code>{' '}
        still keeps this folder out of file sync.
      </>
    );
  return `Returns to file sync ${removalTime}.`;
}

export function ManagedExclusionsSection({
  projectId,
  remoteId,
  placement,
}: {
  projectId: string;
  remoteId?: string;
  placement: 'connect' | 'settings';
}) {
  const headingId = useId();
  const api = useRemoteVmApi();
  const query = useQuery(
    {
      queryKey: managedExclusionsQueryKey(projectId, remoteId),
      queryFn: ({ signal }) => api.readManagedExclusions(projectId, remoteId, signal),
      staleTime: Infinity,
      refetchOnMount: 'always',
      retry: false,
    },
    useHomeQueryClient(),
  );
  const loading = query.isPending || query.isFetching;
  const exclusions = query.data?.exclusions ?? [];
  if (!loading && !query.error && exclusions.length === 0) return null;

  const removalTime =
    placement === 'connect'
      ? 'when this Connect finishes'
      : 'at the next Connect or the next restart of DevChain on this PC';

  let content: ReactNode;
  if (loading) {
    content = (
      <BusyStatus className="text-muted-foreground">Checking Docker data folders…</BusyStatus>
    );
  } else if (query.error) {
    content = (
      <p role="alert" className="break-words text-destructive">
        {query.error.message}
      </p>
    );
  } else {
    content = (
      <ul className="divide-y rounded-md border">
        {exclusions.map((row) => (
          <li key={row.pattern} className="break-words px-3 py-2">
            <code className="font-medium">{row.pattern}</code>
            <p className="text-muted-foreground">
              {row.containers.length
                ? `Docker data of ${row.containers.join(', ')}`
                : 'Docker data, container unknown'}
            </p>
            <p>{describeExclusion(row, removalTime)}</p>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-2 text-sm">
      <h3 id={headingId} className="font-medium">
        {placement === 'connect' ? 'Excluded now' : 'Docker data folders'}
      </h3>
      {content}
    </section>
  );
}
