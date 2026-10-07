import { useMutation, useQuery } from '@tanstack/react-query';
import { FileSyncAutoFixSchema } from '@/modules/file-sync/file-sync-auto-fix.dto';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { Checkbox } from '@/ui/components/ui/checkbox';
import { readErrorMessage } from '@/ui/hooks/useRemotes';
import { apiFetch, HOME_BACKEND } from '@/ui/lib/api-transport';

export function FileSyncAutoFixControls({
  projectId,
  disabled,
}: {
  projectId: string;
  disabled: boolean;
}) {
  const client = useHomeQueryClient();
  const queryKey = [HOME_BACKEND, 'file-sync-auto-fix', projectId];
  const path = `/api/projects/${encodeURIComponent(projectId)}/file-sync/auto-fix`;
  const read = async (init?: RequestInit) => {
    const response = await apiFetch(path, init, { backend: HOME_BACKEND });
    if (!response.ok)
      throw new Error(
        await readErrorMessage(
          response,
          init?.method === 'PUT'
            ? 'Could not save automatic file sync settings.'
            : 'Could not read automatic file sync settings.',
        ),
      );
    return FileSyncAutoFixSchema.parse(await response.json());
  };
  const query = useQuery(
    {
      queryKey,
      queryFn: ({ signal }) => read({ signal }),
      retry: false,
      refetchOnMount: 'always',
      refetchInterval: 30_000,
    },
    client,
  );
  const mutation = useMutation(
    {
      mutationFn: (enabled: boolean) =>
        read({
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled }),
        }),
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
