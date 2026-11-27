import { useIsMutating, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useCrudMutation } from '@/ui/hooks/useCrudMutations';
import { useConfirmDialog } from '@/ui/hooks/useFormDialog';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { useToast } from '@/ui/hooks/use-toast';
import { chatQueryKeys } from '@/ui/hooks/useChatQueries';
import {
  agentSessionTreeKey,
  agentSessionTreeKeyPrefix,
  deleteSessionHistoryItem,
  renameSession,
  type ActiveSession,
  type SessionTreeNode,
  type SessionTreePage,
} from '@/ui/lib/sessions';

export function useSessionTreeRecordActions(agentId: string, projectId: string) {
  const apiFetch = useFetchFactory();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const deleteDialog = useConfirmDialog<SessionTreeNode>();
  const treeKey = agentSessionTreeKey(agentId, projectId);
  const renameKey = [...treeKey, 'rename'];
  const rename = useCrudMutation({
    mutationKey: renameKey,
    mutationFn: ({ id, name }: { id: string; name: string | null }) =>
      renameSession(id, projectId, name, apiFetch),
    invalidateKeys: [agentSessionTreeKeyPrefix],
    optimistic: {
      queryKey: treeKey,
      project: (current, { id, name }) => {
        const data = current as InfiniteData<SessionTreePage> | undefined;
        return (
          data && {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              items: page.items.map((node) => (node.id === id ? { ...node, name } : node)),
            })),
          }
        );
      },
    },
    toast: {
      error: (error) => ({
        title: 'Rename failed',
        description: error instanceof Error ? error.message : 'Unable to rename session.',
      }),
    },
    onSuccessSideEffects: (record) => {
      queryClient.setQueryData<ActiveSession[]>(
        chatQueryKeys.activeSessions(projectId),
        (sessions) =>
          sessions?.map((session) =>
            session.id === record.id ? { ...session, name: record.name } : session,
          ),
      );
    },
  });

  const remove = useCrudMutation({
    mutationFn: (id: string) => deleteSessionHistoryItem(id, projectId, apiFetch),
    invalidateKeys: [agentSessionTreeKeyPrefix],
    toast: {
      success: () => ({
        title: 'Session record deleted',
        description: 'The transcript is still on disk.',
      }),
      error: (error) => ({
        title: 'Delete failed',
        description: error instanceof Error ? error.message : 'Unable to delete session record.',
      }),
    },
  });

  // The mutation cache outlives a closed Sessions modal. A rename that is still in flight
  // keeps blocking the next one, so an older failure cannot roll back a newer name.
  const renamePending = useIsMutating({ mutationKey: renameKey }) > 0;

  function renameRecord(node: SessionTreeNode, draft: string) {
    const name = draft.trim() || null;
    if (name === node.name || renamePending) return;
    rename.mutate({ id: node.id, name });
  }

  function submitDelete() {
    if (deleteDialog.target) remove.mutate(deleteDialog.target.id);
  }

  async function copyId(node: SessionTreeNode) {
    try {
      await navigator.clipboard.writeText(node.providerSessionId ?? node.id);
      toast({
        description: `${node.providerSessionId ? 'Provider session ID' : 'DevChain session ID'} copied.`,
      });
    } catch {
      toast({ variant: 'destructive', description: "Couldn't copy to clipboard." });
    }
  }

  return {
    deleteDialog,
    renamePending,
    renameRecord,
    submitDelete,
    copyId,
  };
}
