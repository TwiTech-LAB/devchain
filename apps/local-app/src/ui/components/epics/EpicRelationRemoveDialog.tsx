import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ConfirmDialog } from '@/ui/components/shared/ConfirmDialog';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { useDeleteEpicRelation } from '@/ui/hooks/useEpicRelations';
import {
  RELATION_ROUTE_HISTORY_WARNING,
  relationRouteChangeWarning,
  type EpicRelation,
} from '@/ui/lib/epic-relations';

export function useRelationTargetFacts(targetId: string | null) {
  const apiFetch = useFetchFactory();
  return useQuery({
    queryKey: ['epic', 'relation-target', targetId],
    queryFn: async ({ signal }): Promise<{ parentId: string | null; projectId: string }> => {
      const res = await apiFetch(`/api/epics/${encodeURIComponent(targetId!)}`, { signal });
      if (!res.ok) throw new Error('The linked Epic could not be loaded.');
      return res.json();
    },
    enabled: targetId !== null,
    staleTime: 60_000,
  });
}

/**
 * Removal confirmation shared by the Epic detail card and the Board relation
 * preview. Controlled by the selected relation: open while it is non-null,
 * closed by the caller clearing it. The dialog closes only after the delete
 * succeeds; a failure keeps it open with the error in place.
 */
export function EpicRelationRemoveDialog({
  epicId,
  epicTitle,
  focalProjectId,
  focalIsRoot,
  relation,
  onClose,
}: {
  epicId: string;
  epicTitle: string;
  focalProjectId: string;
  focalIsRoot: boolean;
  relation: EpicRelation | null;
  onClose: () => void;
}) {
  const deleteRelation = useDeleteEpicRelation(epicId);
  const targetId = relation?.relatedEpic.id ?? null;
  const targetQuery = useRelationTargetFacts(targetId);

  // A ref, not state: ConfirmDialog requests a close synchronously inside the
  // same click that starts the delete, before any pending state re-renders.
  const deleteInFlightRef = useRef(false);
  const [deleteStarted, setDeleteStarted] = useState(false);

  const handleOpenChange = (open: boolean): void => {
    if (open) return;
    if (deleteInFlightRef.current) return;
    deleteRelation.reset();
    onClose();
  };

  const handleConfirm = (): void => {
    if (!relation || deleteInFlightRef.current) return;
    deleteInFlightRef.current = true;
    setDeleteStarted(true);
    deleteRelation.mutate(
      { relatedEpicId: relation.relatedEpic.id },
      {
        onSuccess: () => {
          deleteInFlightRef.current = false;
          setDeleteStarted(false);
          onClose();
        },
        onError: () => {
          deleteInFlightRef.current = false;
          setDeleteStarted(false);
        },
      },
    );
  };

  // A directed Related removal's warning depends on the target Epic row: the
  // confirm action stays blocked until those facts settle so the user can
  // never approve a generic warning in place of the route context.
  const removalContextLoading = Boolean(
    relation &&
      relation.type === 'related' &&
      relation.sourceEpicId !== null &&
      targetQuery.isLoading,
  );

  // Removal warning lines: every variant states that historical provider time
  // never moves, and an eligible directed Related pair names the exact source
  // and target whose time flow the deletion ends.
  const removeWarningLines = useMemo(() => {
    if (!relation) return [];
    const endpoints = [
      { id: epicId, title: epicTitle },
      { id: relation.relatedEpic.id, title: relation.relatedEpic.title },
    ];
    if (relation.type !== 'related') {
      return ['Deleting removes this Blocks relation.', RELATION_ROUTE_HISTORY_WARNING];
    }
    if (relation.sourceEpicId === null) {
      const lines = ['Deleting removes this Related pair. It carries no direction yet.'];
      if (relation.relatedEpic.project.id !== focalProjectId) {
        lines.push('A cross-project Related link never affects Epic time.');
      }
      lines.push(RELATION_ROUTE_HISTORY_WARNING);
      return lines;
    }
    const eligible =
      focalIsRoot &&
      targetQuery.data?.parentId === null &&
      targetQuery.data?.projectId === focalProjectId;
    if (!eligible) {
      return ['Deleting removes this Related pair.', RELATION_ROUTE_HISTORY_WARNING];
    }
    return relationRouteChangeWarning(
      'delete',
      { sourceEpicId: relation.sourceEpicId, targetEpicId: relation.targetEpicId! },
      endpoints,
    );
  }, [epicId, epicTitle, focalIsRoot, focalProjectId, relation, targetQuery.data]);

  const deleteError = deleteRelation.error?.message ?? null;

  return (
    <ConfirmDialog
      open={relation !== null}
      onOpenChange={handleOpenChange}
      title="Remove this relation?"
      description={
        <>
          {removeWarningLines.join(' ')}
          {deleteError ? (
            <span role="alert" className="mt-2 block text-destructive">
              {deleteError}
            </span>
          ) : null}
        </>
      }
      confirmText="Remove"
      cancelText="Cancel"
      loading={deleteRelation.isPending || deleteStarted}
      confirmDisabled={removalContextLoading}
      onConfirm={handleConfirm}
    />
  );
}
