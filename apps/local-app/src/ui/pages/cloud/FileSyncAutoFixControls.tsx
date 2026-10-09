import { useMutation, useQuery } from '@tanstack/react-query';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { Checkbox } from '@/ui/components/ui/checkbox';
import { useRemoteVmApi } from './lib/remote-vm-api-context';
import { fileSyncAutoFixQueryKey } from './lib/remote-vm-query-keys';

export function FileSyncAutoFixControls({
  projectId,
  disabled,
}: {
  projectId: string;
  disabled: boolean;
}) {
  const api = useRemoteVmApi();
  const client = useHomeQueryClient();
  const queryKey = fileSyncAutoFixQueryKey(projectId);
  const query = useQuery(
    {
      queryKey,
      queryFn: ({ signal }) => api.readFileSyncAutoFix(projectId, signal),
      retry: false,
      refetchOnMount: 'always',
      refetchInterval: 30_000,
    },
    client,
  );
  const mutation = useMutation(
    {
      mutationFn: (enabled: boolean) => api.setFileSyncAutoFix(projectId, enabled),
      onSuccess: (value) => client.setQueryData(queryKey, value),
    },
    client,
  );
  return (
    <section aria-label="Automatic file sync fixes" className="space-y-2 text-sm">
      <label className="flex items-center gap-2">
        <Checkbox
          checked={query.data?.enabled ?? true}
          disabled={disabled || !query.data || mutation.isPending}
          onCheckedChange={(value) => mutation.mutate(value === true)}
        />
        Fix file sync problems automatically
      </label>
      {(mutation.error || query.error) && (
        <p role="alert" className="text-destructive">
          {(mutation.error || query.error)?.message}
        </p>
      )}
      {query.data?.actions.map((action, index) => (
        <p key={`${action.at}:${action.side}:${index}`}>
          {action.kind === 'exclude' ? 'Added automatically on' : 'Owner changed on'}{' '}
          {new Date(action.at).toLocaleString()}:{' '}
          {(action.kind === 'exclude' ? action.patterns : action.paths).join(', ')}
        </p>
      ))}
    </section>
  );
}
