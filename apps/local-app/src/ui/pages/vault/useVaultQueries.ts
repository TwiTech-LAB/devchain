import { useMutation, useQuery } from '@tanstack/react-query';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import {
  fetchVaultProjectContext,
  fetchVaultStatus,
  listVaultAccess,
  listVaultEntries,
  listVaultGrants,
  listVaultUseApprovals,
  removeVaultUseApproval,
  vaultQueryKeys,
} from '@/ui/lib/vault';

const UNLOCKING_POLL_MS = 2_000;

export function useVaultStatus() {
  return useQuery(
    {
      queryKey: vaultQueryKeys.status(),
      queryFn: fetchVaultStatus,
      refetchInterval: (q) => (q.state.data?.state === 'unlocking' ? UNLOCKING_POLL_MS : false),
    },
    useHomeQueryClient(),
  );
}

export function useVaultEntries(enabled = true) {
  return useQuery(
    { queryKey: vaultQueryKeys.entries(), queryFn: listVaultEntries, enabled },
    useHomeQueryClient(),
  );
}

/** Grant rows of every entry, in one call. */
export function useVaultGrants(enabled = true) {
  return useQuery(
    { queryKey: vaultQueryKeys.grants(), queryFn: () => listVaultGrants(), enabled },
    useHomeQueryClient(),
  );
}

/** Vault access rows of every project, in one call. */
export function useVaultAccess(enabled = true) {
  return useQuery(
    { queryKey: vaultQueryKeys.access(), queryFn: listVaultAccess, enabled },
    useHomeQueryClient(),
  );
}

/** One entry's "never ask again" rows. */
export function useVaultUseApprovals(entryId: string) {
  return useQuery(
    {
      queryKey: vaultQueryKeys.approvals(entryId),
      queryFn: () => listVaultUseApprovals(entryId),
    },
    useHomeQueryClient(),
  );
}

/** Removes one approval row at once and keeps the entry's list current. */
export function useRemoveVaultUseApproval(entryId: string) {
  const queryClient = useHomeQueryClient();
  return useMutation(
    {
      mutationFn: removeVaultUseApproval,
      onSuccess: (rows) => queryClient.setQueryData(vaultQueryKeys.approvals(entryId), rows),
    },
    queryClient,
  );
}

export function useVaultProjectContext(projectId: string, enabled = true) {
  return useQuery(
    {
      queryKey: vaultQueryKeys.projectContext(projectId),
      queryFn: () => fetchVaultProjectContext(projectId),
      staleTime: 30_000,
      enabled,
    },
    useHomeQueryClient(),
  );
}
