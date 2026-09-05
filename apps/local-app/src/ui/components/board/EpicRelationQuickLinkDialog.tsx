import { useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { useSetEpicRelation } from '@/ui/hooks/useEpicRelations';
import { useEpicExternalSourcesBatch } from '@/ui/hooks/useEpicExternalSourcesBatch';
import {
  getRelatedRouteEligibility,
  isEpicRelationConfirmationError,
  relationRouteBoundaryWarning,
  relationRouteChangeKind,
  relationRouteChangeWarning,
  type EpicRelationDirectionDraft,
  type EpicRelationRouteEffect,
} from '@/ui/lib/epic-relations';
import { Alert, AlertDescription } from '@/ui/components/ui/alert';
import { Button } from '@/ui/components/ui/button';
import { EpicRelationDirectionPicker } from '@/ui/components/epics/EpicRelationDirectionPicker';
import { RelationRouteWarning } from '@/ui/components/epics/RelationRouteWarning';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import type { EpicRelationConfirmation } from '@/ui/hooks/useBoardRelationQuickLink';

export interface EpicRelationQuickLinkDialogProps {
  confirmation: EpicRelationConfirmation | null;
  onCancel(): void;
  onSuccess(): void;
}

const DEFAULT_DRAFT: EpicRelationDirectionDraft = { type: 'related', sourceIsFocal: true };

export function EpicRelationQuickLinkDialog({
  confirmation,
  onCancel,
  onSuccess,
}: EpicRelationQuickLinkDialogProps) {
  const [draft, setDraft] = useState<EpicRelationDirectionDraft>(DEFAULT_DRAFT);
  const target = confirmation?.target ?? null;
  const mutation = useSetEpicRelation();
  const resetMutation = mutation.reset;

  useEffect(() => {
    setDraft(DEFAULT_DRAFT);
    resetMutation();
  }, [confirmation?.source.id, confirmation?.target.id, resetMutation]);

  const changeDraft = (next: EpicRelationDirectionDraft) => {
    resetMutation();
    setDraft(next);
  };

  // A Related link routes time only between root Epics of one project; both
  // endpoints arrive as full Epic rows here, so eligibility is known exactly.
  const eligibility: ReturnType<typeof getRelatedRouteEligibility> =
    confirmation && target
      ? getRelatedRouteEligibility({
          sameProject: confirmation.source.projectId === target.projectId,
          focalIsRoot: confirmation.source.parentId === null,
          targetIsRoot: target.parentId === null,
        })
      : { eligible: false };
  const { eligible, ineligibilityCause } = eligibility;

  // Managed-projection confirmation: the two picker endpoints only. Linking
  // a managed projection creates a link boundary for related rollups.
  const { sources: externalSources } = useEpicExternalSourcesBatch(
    target && confirmation ? [confirmation.source.id, target.id] : [],
    { enabled: confirmation !== null },
  );
  const sourceLinked = confirmation
    ? (externalSources?.has(confirmation.source.id) ?? false)
    : false;
  const targetLinked = target ? (externalSources?.has(target.id) ?? false) : false;
  const boundary =
    draft.type === 'related' && eligible
      ? relationRouteBoundaryWarning([
          ...(sourceLinked && confirmation
            ? [{ id: confirmation.source.id, title: confirmation.source.title }]
            : []),
          ...(targetLinked && target ? [{ id: target.id, title: target.title }] : []),
        ])
      : [];

  const confirmationError = isEpicRelationConfirmationError(mutation.error) ? mutation.error : null;
  const routeWarning =
    confirmationError && confirmation && target
      ? relationRouteChangeWarning(
          relationRouteChangeKind(draft, confirmationError.currentEffect, [
            confirmation.source.id,
            target.id,
          ]),
          confirmationError.currentEffect,
          [
            { id: confirmation.source.id, title: confirmation.source.title },
            { id: target.id, title: target.title },
          ],
        )
      : [];

  const save = (accepted?: { acceptedRouteEffect: EpicRelationRouteEffect }) => {
    if (!confirmation || !target) return;
    mutation.mutate(
      {
        sourceEpicId: draft.sourceIsFocal ? confirmation.source.id : target.id,
        targetEpicId: draft.sourceIsFocal ? target.id : confirmation.source.id,
        type: draft.type,
        confirmation: accepted,
      },
      { onSuccess },
    );
  };

  const errorMessage =
    mutation.error instanceof Error && !confirmationError ? mutation.error.message : null;
  let saveLabel = 'Confirm link';
  if (confirmationError) saveLabel = 'Accept route and save';
  if (mutation.isPending) saveLabel = 'Linking…';

  return (
    <Dialog open={confirmation !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Link Epics</DialogTitle>
          <DialogDescription>Review the relation before you link these Epics.</DialogDescription>
        </DialogHeader>

        {confirmation && target ? (
          <div className="space-y-4">
            <EpicRelationDirectionPicker
              source={{ id: confirmation.source.id, title: confirmation.source.title }}
              target={{ id: target.id, title: target.title }}
              value={draft}
              onChange={changeDraft}
              eligible={eligible}
              ineligibilityCause={ineligibilityCause}
              sourceLinked={sourceLinked}
              targetLinked={targetLinked}
              disabled={mutation.isPending}
            />
            {boundary.length > 0 ? (
              <RelationRouteWarning title="Link boundary" lines={boundary} />
            ) : null}
            {confirmationError ? (
              <RelationRouteWarning title="Confirm the current time route" lines={routeWarning} />
            ) : null}
          </div>
        ) : null}

        <p className="text-xs text-muted-foreground">
          Confirming replaces the current type if this Epic pair is already linked.
        </p>

        {errorMessage ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={mutation.isPending || !confirmation}
            onClick={() =>
              save(
                confirmationError
                  ? { acceptedRouteEffect: confirmationError.currentEffect }
                  : undefined,
              )
            }
          >
            {saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
