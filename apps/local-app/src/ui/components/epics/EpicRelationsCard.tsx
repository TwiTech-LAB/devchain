import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Link2, Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/ui/components/ui/alert';
import { ConfirmDialog } from '@/ui/components/shared/ConfirmDialog';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { useEpicExternalSourcesBatch } from '@/ui/hooks/useEpicExternalSourcesBatch';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import {
  useDeleteEpicRelation,
  useEpicRelationCandidates,
  useEpicRelations,
  useSetEpicRelation,
} from '@/ui/hooks/useEpicRelations';
import { projectsQueryKeys } from '@/ui/pages/projects/lib/project-query-keys';
import { EpicRelationDirectionPicker } from '@/ui/components/epics/EpicRelationDirectionPicker';
import { RelationRouteWarning } from '@/ui/components/epics/RelationRouteWarning';
import {
  EPIC_RELATION_TYPE_OPTIONS,
  RELATION_ROUTE_HISTORY_WARNING,
  flattenEpicRelationCandidatePages,
  flattenEpicRelationPages,
  getRelatedRouteEligibility,
  isEpicRelationConfirmationError,
  relatedEpicRole,
  relationRouteBoundaryWarning,
  relationRouteChangeKind,
  relationRouteChangeWarning,
  type EpicRelation,
  type EpicRelationCandidate,
  type EpicRelationConfirmationError,
  type EpicRelationDirectionDraft,
  type EpicRelationRouteEffect,
  type EpicRelationTarget,
  type EpicRelationType,
} from '@/ui/lib/epic-relations';

interface FocalProjectSummary {
  workspaceId: string;
}

interface PendingTypeChange {
  target: EpicRelationTarget;
  nextType: EpicRelationType;
}

interface PendingCrossProjectOpen {
  target: EpicRelationTarget;
}

interface PendingRemove {
  relation: EpicRelation;
}

/** Draft endpoint ids resolved from the arrow state: [sourceId, targetId]. */
function draftEndpoints(
  epicId: string,
  targetId: string,
  draft: EpicRelationDirectionDraft,
): [string, string] {
  return draft.sourceIsFocal ? [epicId, targetId] : [targetId, epicId];
}

function boundaryLines(
  linkedIds: ReadonlySet<string>,
  endpoints: readonly { id: string; title: string }[],
): string[] {
  return relationRouteBoundaryWarning(endpoints.filter((endpoint) => linkedIds.has(endpoint.id)));
}

function relationSaveLabel(
  isPending: boolean,
  confirmationRequired: boolean,
  pendingLabel: string,
  idleLabel: string,
): string {
  if (isPending) return pendingLabel;
  if (confirmationRequired) return 'Accept route and save';
  return idleLabel;
}

function useRelationTargetFacts(targetId: string | null) {
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

interface AddRelationDialogProps {
  epicId: string;
  epicTitle: string;
  focalProjectId: string;
  focalIsRoot: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (
    relatedEpicId: string,
    draft: EpicRelationDirectionDraft,
    confirmation?: { acceptedRouteEffect: EpicRelationRouteEffect },
  ) => void;
  /** Clears a stale typed 409 when the user changes the draft or target. */
  clearConfirmation: () => void;
  isPending: boolean;
  error: string | null;
  /** Typed 409 from the last save attempt; drives the destructive warning. */
  confirmationError: EpicRelationConfirmationError | null;
}

function RelationTargetMeta({ target }: { target: EpicRelationTarget }) {
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <Badge
        style={{ backgroundColor: target.status.color }}
        className="text-white"
        aria-label={`Status: ${target.status.label}`}
      >
        {target.status.label}
      </Badge>
      <span>{target.project.name}</span>
      <span className="font-mono">{target.shortId}</span>
    </span>
  );
}

function CandidateRow({
  candidate,
  onSelect,
  disabled,
}: {
  candidate: EpicRelationCandidate;
  onSelect: (candidate: EpicRelationCandidate) => void;
  disabled: boolean;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(candidate)}
        disabled={disabled}
        className="w-full rounded-lg border bg-muted/30 p-3 text-left transition-colors hover:bg-muted/50 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:opacity-60"
        aria-label={`Select ${candidate.title} (${candidate.shortId})`}
      >
        <span className="block truncate text-sm font-medium">{candidate.title}</span>
        <RelationTargetMeta target={candidate} />
      </button>
    </li>
  );
}

function AddRelationDialog({
  epicId,
  epicTitle,
  focalProjectId,
  focalIsRoot,
  open,
  onOpenChange,
  onAdd,
  clearConfirmation,
  isPending,
  error,
  confirmationError,
}: AddRelationDialogProps) {
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<EpicRelationDirectionDraft>({
    type: 'related',
    sourceIsFocal: true,
  });
  const [selectedCandidate, setSelectedCandidate] = useState<EpicRelationCandidate | null>(null);

  useEffect(() => {
    if (open) {
      setSearch('');
      setDraft({ type: 'related', sourceIsFocal: true });
      setSelectedCandidate(null);
    }
  }, [open]);

  // Any draft or target change invalidates the 409 facts the last save
  // attempt displayed — the user is no longer approving that write.
  const changeDraft = useCallback(
    (next: EpicRelationDirectionDraft) => {
      clearConfirmation();
      setDraft(next);
    },
    [clearConfirmation],
  );
  const changeCandidate = useCallback(
    (next: EpicRelationCandidate | null) => {
      clearConfirmation();
      setSelectedCandidate(next);
    },
    [clearConfirmation],
  );

  const candidates = useEpicRelationCandidates(epicId, search, {
    enabled: open && selectedCandidate === null,
  });
  const items = flattenEpicRelationCandidatePages(candidates.data);
  // Two picker endpoints only: the focal Epic and the selected candidate.
  const { sources: externalSources } = useEpicExternalSourcesBatch(
    selectedCandidate ? [epicId, selectedCandidate.id] : [],
    { enabled: open && selectedCandidate !== null },
  );
  const sourceLinked = externalSources?.has(epicId) ?? false;
  const targetLinked = selectedCandidate
    ? (externalSources?.has(selectedCandidate.id) ?? false)
    : false;

  // A Related link routes time only between root Epics of one project.
  const candidateSameProject = Boolean(
    selectedCandidate && selectedCandidate.project.id === focalProjectId,
  );
  const eligibility: ReturnType<typeof getRelatedRouteEligibility> = selectedCandidate
    ? getRelatedRouteEligibility({
        sameProject: candidateSameProject,
        focalIsRoot,
        targetIsRoot: selectedCandidate.parentId === null,
      })
    : { eligible: false };
  const { eligible, ineligibilityCause } = eligibility;

  const boundary = boundaryLines(
    new Set([
      ...(sourceLinked ? [epicId] : []),
      ...(targetLinked && selectedCandidate ? [selectedCandidate.id] : []),
    ]),
    [
      { id: epicId, title: epicTitle },
      ...(selectedCandidate ? [{ id: selectedCandidate.id, title: selectedCandidate.title }] : []),
    ],
  );
  const showBoundary = draft.type === 'related' && eligible && boundary.length > 0;
  const routeWarning = confirmationError
    ? relationRouteChangeWarning(
        relationRouteChangeKind(draft, confirmationError.currentEffect, [
          epicId,
          selectedCandidate?.id ?? '',
        ]),
        confirmationError.currentEffect,
        [
          { id: epicId, title: epicTitle },
          ...(selectedCandidate
            ? [{ id: selectedCandidate.id, title: selectedCandidate.title }]
            : []),
        ],
      )
    : [];
  const saveLabel = relationSaveLabel(
    isPending,
    confirmationError !== null,
    'Linking…',
    'Confirm link',
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add relation</DialogTitle>
          <DialogDescription>
            {selectedCandidate
              ? 'Review the relation before you link these Epics.'
              : 'Select another Epic in this workspace.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {selectedCandidate ? (
            <EpicRelationDirectionPicker
              source={{ id: epicId, title: epicTitle }}
              target={{
                id: selectedCandidate.id,
                title: selectedCandidate.title,
                subtitle: selectedCandidate.project.name,
              }}
              value={draft}
              onChange={changeDraft}
              eligible={eligible}
              ineligibilityCause={ineligibilityCause}
              sourceLinked={sourceLinked}
              targetLinked={targetLinked}
              disabled={isPending}
            />
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="relation-search">Search epics</Label>
                <Input
                  id="relation-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search by title or ID"
                  autoComplete="off"
                />
              </div>
              <div className="space-y-2">
                {candidates.isLoading ? (
                  <div className="flex items-center justify-center py-4" role="status">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    <span className="ml-2 text-sm text-muted-foreground">Searching epics…</span>
                  </div>
                ) : items.length === 0 ? (
                  <p className="py-2 text-center text-sm text-muted-foreground">
                    {search.trim() ? 'No matching epics.' : 'No linkable epics in this workspace.'}
                  </p>
                ) : (
                  <ul className="max-h-64 space-y-2 overflow-y-auto" aria-label="Candidate epics">
                    {items.map((candidate) => (
                      <CandidateRow
                        key={candidate.id}
                        candidate={candidate}
                        onSelect={changeCandidate}
                        disabled={isPending}
                      />
                    ))}
                  </ul>
                )}
                {candidates.hasNextPage && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => void candidates.fetchNextPage()}
                    disabled={candidates.isFetchingNextPage}
                  >
                    {candidates.isFetchingNextPage && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    Load more
                  </Button>
                )}
              </div>
            </>
          )}
          {showBoundary ? <RelationRouteWarning title="Link boundary" lines={boundary} /> : null}
          {confirmationError ? (
            <RelationRouteWarning title="Confirm the current time route" lines={routeWarning} />
          ) : null}
          {error && !confirmationError ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        {selectedCandidate ? (
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => changeCandidate(null)}
              disabled={isPending}
            >
              Change target
            </Button>
            <Button
              type="button"
              onClick={() =>
                onAdd(
                  selectedCandidate.id,
                  draft,
                  confirmationError
                    ? { acceptedRouteEffect: confirmationError.currentEffect }
                    : undefined,
                )
              }
              disabled={isPending}
            >
              {saveLabel}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RelationRow({
  relation,
  onNavigate,
  onTypeChange,
  onEdit,
  onRemove,
  removePending,
}: {
  relation: EpicRelation;
  onNavigate: (target: EpicRelationTarget) => void;
  onTypeChange: (relation: EpicRelation, nextType: EpicRelationType) => void;
  onEdit: (relation: EpicRelation) => void;
  onRemove: (relatedEpicId: string) => void;
  removePending: boolean;
}) {
  const { relatedEpic } = relation;
  // Row-level direction facts: legacy neutral rows render without error and
  // without any selectable neutral option elsewhere; directed Related rows
  // mark the related Epic's role in the linkage.
  const relatedRole = relatedEpicRole(relation);
  return (
    <li className="rounded-lg border bg-muted/30 p-3">
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={() => onNavigate(relatedEpic)}
          className="min-w-0 flex-1 rounded-md text-left focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          aria-label={`Open ${relatedEpic.title} (${relatedEpic.shortId})`}
        >
          <span className="block truncate text-sm font-medium">{relatedEpic.title}</span>
          <RelationTargetMeta target={relatedEpic} />
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {relation.type === 'related' && relatedRole ? (
            <Badge variant="secondary" className="mr-1">
              {relatedRole}
            </Badge>
          ) : null}
          {relation.type === 'related' && relatedRole === null ? (
            <Badge variant="outline" className="mr-1">
              No direction yet
            </Badge>
          ) : null}
          {relation.type === 'related' ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onEdit(relation)}
              aria-label={`Edit relation with ${relatedEpic.title}`}
            >
              <Pencil className="h-4 w-4 text-muted-foreground" />
            </Button>
          ) : null}
          <select
            value={relation.type}
            onChange={(event) => onTypeChange(relation, event.target.value as EpicRelationType)}
            aria-label={`Relation type for ${relatedEpic.title}`}
            className="h-8 rounded-md border border-input bg-transparent px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {EPIC_RELATION_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRemove(relatedEpic.id)}
            disabled={removePending}
            aria-label={`Remove relation with ${relatedEpic.title}`}
          >
            <Trash2 className="h-4 w-4 text-muted-foreground" />
          </Button>
        </div>
      </div>
    </li>
  );
}

function RelationGroup({
  title,
  ariaLabel,
  relations,
  onNavigate,
  onTypeChange,
  onEdit,
  onRemove,
  removePending,
}: {
  title: string;
  ariaLabel: string;
  relations: EpicRelation[];
  onNavigate: (target: EpicRelationTarget) => void;
  onTypeChange: (relation: EpicRelation, nextType: EpicRelationType) => void;
  onEdit: (relation: EpicRelation) => void;
  onRemove: (relatedEpicId: string) => void;
  removePending: boolean;
}) {
  if (relations.length === 0) return null;

  return (
    <section aria-label={ariaLabel}>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title} ({relations.length})
      </h4>
      <ul className="space-y-2">
        {relations.map((relation) => (
          <RelationRow
            key={relation.relationId}
            relation={relation}
            onNavigate={onNavigate}
            onTypeChange={onTypeChange}
            onEdit={onEdit}
            onRemove={onRemove}
            removePending={removePending}
          />
        ))}
      </ul>
    </section>
  );
}

interface EditRelationDialogProps {
  epicId: string;
  epicTitle: string;
  focalProjectId: string;
  focalIsRoot: boolean;
  relation: EpicRelation | null;
  onOpenChange: (open: boolean) => void;
  onSave: (
    relatedEpicId: string,
    draft: EpicRelationDirectionDraft,
    confirmation?: { acceptedRouteEffect: EpicRelationRouteEffect },
  ) => void;
  /** Clears a stale typed 409 when the user changes the draft. */
  clearConfirmation: () => void;
  isPending: boolean;
  confirmationError: EpicRelationConfirmationError | null;
}

function EditRelationDialog({
  epicId,
  epicTitle,
  focalProjectId,
  focalIsRoot,
  relation,
  onOpenChange,
  onSave,
  clearConfirmation,
  isPending,
  confirmationError,
}: EditRelationDialogProps) {
  const [draft, setDraft] = useState<EpicRelationDirectionDraft>({
    type: 'related',
    sourceIsFocal: true,
  });
  const target = relation?.relatedEpic ?? null;
  const legacyNeutral = relation !== null && relation.sourceEpicId === null;

  // Any draft change invalidates the 409 facts the last save attempt
  // displayed — the user is no longer approving that write.
  const changeDraft = useCallback(
    (next: EpicRelationDirectionDraft) => {
      clearConfirmation();
      setDraft(next);
    },
    [clearConfirmation],
  );

  useEffect(() => {
    if (relation) {
      // The stored row decides the initial arrow: its semantic source is the
      // draft source. Legacy neutral rows default to the focal Epic.
      const sourceIsFocal =
        relation.type === 'blocked_by'
          ? false
          : relation.sourceEpicId === null || relation.sourceEpicId === epicId;
      setDraft({
        type: relation.type === 'related' ? 'related' : 'blocks',
        sourceIsFocal,
      });
    }
  }, [epicId, relation]);

  // The stored direction says who is source, but eligibility needs the target
  // Epic's parent and project rows; the read endpoint carries both.
  const targetEpicQuery = useRelationTargetFacts(target?.id ?? null);

  const { sources: externalSources } = useEpicExternalSourcesBatch(
    target ? [epicId, target.id] : [],
    { enabled: relation !== null },
  );
  const endpoints = useMemo(
    () => [
      { id: epicId, title: epicTitle },
      ...(target ? [{ id: target.id, title: target.title }] : []),
    ],
    [epicId, epicTitle, target],
  );
  const sourceLinked = externalSources?.has(epicId) ?? false;
  const targetLinked = target ? (externalSources?.has(target.id) ?? false) : false;
  const boundary = boundaryLines(
    new Set([...(sourceLinked ? [epicId] : []), ...(targetLinked && target ? [target.id] : [])]),
    endpoints,
  );
  const eligibility: ReturnType<typeof getRelatedRouteEligibility> = target
    ? getRelatedRouteEligibility({
        sameProject: target.project.id === focalProjectId,
        focalIsRoot,
        targetIsRoot: targetEpicQuery.data ? targetEpicQuery.data.parentId === null : null,
      })
    : { eligible: false };
  const { eligible, ineligibilityCause } = eligibility;
  const routeWarning =
    confirmationError && target
      ? relationRouteChangeWarning(
          relationRouteChangeKind(draft, confirmationError.currentEffect, [epicId, target.id]),
          confirmationError.currentEffect,
          endpoints,
        )
      : [];
  const saveLabel = relationSaveLabel(
    isPending,
    confirmationError !== null,
    'Saving…',
    'Save changes',
  );

  return (
    <Dialog open={relation !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit relation</DialogTitle>
          <DialogDescription>Adjust the type and direction for this Epic pair.</DialogDescription>
        </DialogHeader>
        {target ? (
          <div className="space-y-4">
            <EpicRelationDirectionPicker
              source={{ id: epicId, title: epicTitle }}
              target={{
                id: target.id,
                title: target.title,
                subtitle: target.project.name,
              }}
              value={draft}
              onChange={changeDraft}
              eligible={eligible}
              ineligibilityCause={ineligibilityCause}
              legacyNeutral={legacyNeutral}
              sourceLinked={sourceLinked}
              targetLinked={targetLinked}
              disabled={isPending}
            />
            {draft.type === 'related' && eligible && boundary.length > 0 ? (
              <RelationRouteWarning title="Link boundary" lines={boundary} />
            ) : null}
            {confirmationError ? (
              <RelationRouteWarning title="Confirm the current time route" lines={routeWarning} />
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={isPending || !target}
            onClick={() => {
              if (!target) return;
              onSave(
                target.id,
                draft,
                confirmationError
                  ? { acceptedRouteEffect: confirmationError.currentEffect }
                  : undefined,
              );
            }}
          >
            {saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function EpicRelationsCard({
  epicId,
  epicTitle,
  focalProjectId,
  focalIsRoot,
}: {
  epicId: string;
  epicTitle: string;
  focalProjectId: string;
  focalIsRoot: boolean;
}) {
  const navigate = useNavigate();
  const apiFetch = useFetchFactory();
  const { selectedProject, activateProject } = useSelectedProject();
  const relationsQuery = useEpicRelations(epicId);
  const setRelation = useSetEpicRelation();
  const deleteRelation = useDeleteEpicRelation(epicId);
  const [addOpen, setAddOpen] = useState(false);
  const [pendingTypeChange, setPendingTypeChange] = useState<PendingTypeChange | null>(null);
  const [pendingCrossProjectOpen, setPendingCrossProjectOpen] =
    useState<PendingCrossProjectOpen | null>(null);
  const [editRelation, setEditRelation] = useState<EpicRelation | null>(null);
  const [pendingRemove, setPendingRemove] = useState<PendingRemove | null>(null);

  // The removal confirmation resolves the target's eligibility from the Epic
  // row so the warning names source and target only when the pair actually
  // routes time.
  const pendingRemoveTargetId = pendingRemove?.relation.relatedEpic.id ?? null;
  const pendingRemoveTargetQuery = useRelationTargetFacts(pendingRemoveTargetId);

  const focalProjectQuery = useQuery({
    queryKey: projectsQueryKeys.detail({ id: focalProjectId }),
    queryFn: async ({ signal }): Promise<FocalProjectSummary> => {
      const res = await apiFetch(`/api/projects/${encodeURIComponent(focalProjectId)}`, {
        signal,
      });
      if (!res.ok) throw new Error('The focal project could not be loaded.');
      return res.json();
    },
    enabled: Boolean(focalProjectId) && selectedProject?.id !== focalProjectId,
    staleTime: 60_000,
  });

  const relations = flattenEpicRelationPages(relationsQuery.data);
  const total = relationsQuery.data?.pages.at(-1)?.total ?? relations.length;

  const grouped = useMemo(
    () => ({
      related: relations.filter((relation) => relation.type === 'related'),
      blocks: relations.filter((relation) => relation.type === 'blocks'),
      blockedBy: relations.filter((relation) => relation.type === 'blocked_by'),
    }),
    [relations],
  );

  // Relations never cross workspaces, so the focal project's workspace is also
  // the workspace of every cross-project target shown in this card.
  const resolveCrossProjectWorkspaceId = useCallback((): string | undefined => {
    if (selectedProject?.id === focalProjectId) return selectedProject.workspaceId;
    return focalProjectQuery.data?.workspaceId;
  }, [focalProjectId, focalProjectQuery.data?.workspaceId, selectedProject]);

  // Fails closed: a cross-project target navigates only after its project is
  // activated, and activation requires a resolved workspace ID. Until then the
  // click is held in a visible pending state instead of navigating under the
  // wrong project context.
  const attemptOpenRelatedEpic = useCallback(
    (target: EpicRelationTarget): boolean => {
      if (target.project.id === selectedProject?.id) {
        navigate(`/epics/${target.id}`);
        return true;
      }
      const workspaceId = resolveCrossProjectWorkspaceId();
      if (!workspaceId) return false;
      activateProject({ id: target.project.id, workspaceId });
      navigate(`/epics/${target.id}`);
      return true;
    },
    [activateProject, navigate, resolveCrossProjectWorkspaceId, selectedProject],
  );

  const openRelatedEpic = useCallback(
    (target: EpicRelationTarget) => {
      if (attemptOpenRelatedEpic(target)) {
        setPendingCrossProjectOpen(null);
        return;
      }
      setPendingCrossProjectOpen({ target });
    },
    [attemptOpenRelatedEpic],
  );

  // A held cross-project click completes itself as soon as workspace metadata
  // arrives (initial load, refetch after failure, or selection change).
  useEffect(() => {
    if (!pendingCrossProjectOpen) return;
    if (attemptOpenRelatedEpic(pendingCrossProjectOpen.target)) {
      setPendingCrossProjectOpen(null);
    }
  }, [attemptOpenRelatedEpic, pendingCrossProjectOpen]);

  const handleAdd = useCallback(
    (
      relatedEpicId: string,
      draft: EpicRelationDirectionDraft,
      confirmation?: { acceptedRouteEffect: EpicRelationRouteEffect },
    ) => {
      // The write's endpoint order defines direction: the arrow state picks
      // the source, and a swap is a write with the pair reversed.
      const [sourceEpicId, targetEpicId] = draftEndpoints(epicId, relatedEpicId, draft);
      setRelation.mutate(
        { sourceEpicId, targetEpicId, type: draft.type, confirmation },
        { onSuccess: () => setAddOpen(false) },
      );
    },
    [epicId, setRelation],
  );

  const handleEditSave = useCallback(
    (
      relatedEpicId: string,
      draft: EpicRelationDirectionDraft,
      confirmation?: { acceptedRouteEffect: EpicRelationRouteEffect },
    ) => {
      const [sourceEpicId, targetEpicId] = draftEndpoints(epicId, relatedEpicId, draft);
      setRelation.mutate(
        { sourceEpicId, targetEpicId, type: draft.type, confirmation },
        { onSuccess: () => setEditRelation(null) },
      );
    },
    [epicId, setRelation],
  );

  const handleTypeChange = useCallback((relation: EpicRelation, nextType: EpicRelationType) => {
    if (nextType === relation.type) return;
    setPendingTypeChange({ target: relation.relatedEpic, nextType });
  }, []);

  const handleEdit = useCallback(
    (relation: EpicRelation) => {
      setRelation.reset();
      setEditRelation(relation);
    },
    [setRelation],
  );

  const handleRemove = useCallback(
    (relatedEpicId: string) => {
      const relation = relations.find((item) => item.relatedEpic.id === relatedEpicId);
      if (!relation) return;
      // Deletion is destructive: the themed confirmation states the effect
      // the user approves before any request leaves.
      setPendingRemove({ relation });
    },
    [relations],
  );

  const confirmRemove = useCallback(() => {
    const pending = pendingRemove;
    if (!pending) return;
    deleteRelation.mutate({ relatedEpicId: pending.relation.relatedEpic.id });
    setPendingRemove(null);
  }, [deleteRelation, pendingRemove]);

  const confirmTypeChange = useCallback(() => {
    const pending = pendingTypeChange;
    if (!pending) return;
    // The row's select stays focal-relative, so the write keeps the focal
    // address first and lets the type carry blocks polarity. Converting a
    // routed Related pair displaces its route: the first attempt returns the
    // typed 409 whose facts the visible warning echoes on the retry below.
    setRelation.mutate(
      {
        sourceEpicId: epicId,
        targetEpicId: pending.target.id,
        type: pending.nextType,
        confirmation: isEpicRelationConfirmationError(setRelation.error)
          ? { acceptedRouteEffect: setRelation.error.currentEffect }
          : undefined,
      },
      { onSuccess: () => setPendingTypeChange(null) },
    );
  }, [epicId, pendingTypeChange, setRelation]);

  const setConfirmationError = isEpicRelationConfirmationError(setRelation.error)
    ? setRelation.error
    : null;
  const mutationError = setRelation.error?.message ?? deleteRelation.error?.message ?? null;

  // A directed Related removal's warning depends on the target Epic row: the
  // confirm action stays blocked until those facts settle so the user can
  // never approve a generic warning in place of the route context.
  const removalContextLoading = Boolean(
    pendingRemove &&
      pendingRemove.relation.type === 'related' &&
      pendingRemove.relation.sourceEpicId !== null &&
      pendingRemoveTargetQuery.isLoading,
  );

  // Removal warning lines: every variant states that historical provider time
  // never moves, and an eligible directed Related pair names the exact source
  // and target whose time flow the deletion ends.
  const removeWarningLines = useMemo(() => {
    const pending = pendingRemove;
    if (!pending) return [];
    const { relation } = pending;
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
      pendingRemoveTargetQuery.data?.parentId === null &&
      pendingRemoveTargetQuery.data?.projectId === focalProjectId;
    if (!eligible) {
      return ['Deleting removes this Related pair.', RELATION_ROUTE_HISTORY_WARNING];
    }
    return relationRouteChangeWarning(
      'delete',
      { sourceEpicId: relation.sourceEpicId, targetEpicId: relation.targetEpicId! },
      endpoints,
    );
  }, [
    epicId,
    epicTitle,
    focalIsRoot,
    focalProjectId,
    pendingRemove,
    pendingRemoveTargetQuery.data,
  ]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Link2 className="h-5 w-5" />
            Relations{relationsQuery.data ? ` (${total})` : ''}
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => setAddOpen(true)}
            aria-label="Add relation"
          >
            <Plus className="mr-1 h-4 w-4" />
            Add
          </Button>
        </div>
        <CardDescription>
          Related, blocking, and blocked-by epics in this workspace.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {pendingCrossProjectOpen && (
          <Alert variant={focalProjectQuery.isError ? 'destructive' : 'default'}>
            <AlertTitle>
              {focalProjectQuery.isError ? 'Project unavailable' : 'Opening project…'}
            </AlertTitle>
            <AlertDescription>
              {focalProjectQuery.isError ? (
                <>
                  {`The workspace for ${pendingCrossProjectOpen.target.project.name} could not be loaded. `}
                  <Button
                    variant="link"
                    className="h-auto p-0"
                    onClick={() => void focalProjectQuery.refetch()}
                  >
                    Retry
                  </Button>
                </>
              ) : (
                <>
                  {`Preparing ${pendingCrossProjectOpen.target.project.name}. The epic opens after its project is active. `}
                  <Button
                    variant="link"
                    className="h-auto p-0"
                    onClick={() => setPendingCrossProjectOpen(null)}
                  >
                    Cancel
                  </Button>
                </>
              )}
            </AlertDescription>
          </Alert>
        )}
        {relationsQuery.isLoading ? (
          <div className="flex items-center justify-center py-4" role="status">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : relationsQuery.isError ? (
          <div className="space-y-2">
            <Alert variant="destructive">
              <AlertTitle>Relations unavailable</AlertTitle>
              <AlertDescription>
                Relations could not be loaded.{' '}
                <Button
                  variant="link"
                  className="h-auto p-0"
                  onClick={() => void relationsQuery.refetch()}
                >
                  <RefreshCw className="mr-1 h-3 w-3" />
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        ) : total === 0 ? (
          <div className="text-center py-4">
            <Link2 className="h-8 w-8 mx-auto text-muted-foreground/50 mb-2" />
            <p className="text-sm text-muted-foreground">No relations yet.</p>
            <p className="mt-1 text-xs text-muted-foreground/70">
              Link an epic to group related work or mark blockers.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <RelationGroup
              title="Related"
              ariaLabel="Related epics"
              relations={grouped.related}
              onNavigate={openRelatedEpic}
              onTypeChange={handleTypeChange}
              onEdit={handleEdit}
              onRemove={handleRemove}
              removePending={deleteRelation.isPending}
            />
            <RelationGroup
              title="Blocks"
              ariaLabel="Blocking epics"
              relations={grouped.blocks}
              onNavigate={openRelatedEpic}
              onTypeChange={handleTypeChange}
              onEdit={handleEdit}
              onRemove={handleRemove}
              removePending={deleteRelation.isPending}
            />
            <RelationGroup
              title="Blocked by"
              ariaLabel="Blocked-by epics"
              relations={grouped.blockedBy}
              onNavigate={openRelatedEpic}
              onTypeChange={handleTypeChange}
              onEdit={handleEdit}
              onRemove={handleRemove}
              removePending={deleteRelation.isPending}
            />
            {relationsQuery.hasNextPage && (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => void relationsQuery.fetchNextPage()}
                disabled={relationsQuery.isFetchingNextPage}
              >
                {relationsQuery.isFetchingNextPage && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Load more ({relations.length} of {total})
              </Button>
            )}
          </div>
        )}
        {mutationError && (
          <p className="text-sm text-destructive" role="alert">
            {mutationError}
          </p>
        )}
      </CardContent>
      <AddRelationDialog
        epicId={epicId}
        epicTitle={epicTitle}
        focalProjectId={focalProjectId}
        focalIsRoot={focalIsRoot}
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) setRelation.reset();
        }}
        onAdd={handleAdd}
        clearConfirmation={setRelation.reset}
        isPending={setRelation.isPending}
        error={setRelation.error instanceof Error ? setRelation.error.message : null}
        confirmationError={addOpen ? setConfirmationError : null}
      />
      <EditRelationDialog
        epicId={epicId}
        epicTitle={epicTitle}
        focalProjectId={focalProjectId}
        focalIsRoot={focalIsRoot}
        relation={editRelation}
        onOpenChange={(open) => {
          if (!open) {
            setEditRelation(null);
            setRelation.reset();
          }
        }}
        onSave={handleEditSave}
        clearConfirmation={setRelation.reset}
        isPending={setRelation.isPending}
        confirmationError={editRelation !== null ? setConfirmationError : null}
      />
      <ConfirmDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
        title="Remove this relation?"
        description={removeWarningLines.join(' ')}
        confirmText="Remove"
        cancelText="Cancel"
        loading={deleteRelation.isPending}
        confirmDisabled={removalContextLoading}
        onConfirm={confirmRemove}
      />
      <ConfirmDialog
        open={pendingTypeChange !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingTypeChange(null);
            setRelation.reset();
          }
        }}
        title="Change relation type?"
        description={
          pendingTypeChange
            ? [
                `Changing the type replaces the existing relation with “${pendingTypeChange.target.title}”. One epic pair keeps a single type.`,
                ...(pendingTypeChange.nextType !== 'related'
                  ? ['Converting to Blocks removes the Related pair’s time route.']
                  : []),
                ...(setConfirmationError && pendingTypeChange
                  ? relationRouteChangeWarning(
                      // The warning kind follows the pending write, not this
                      // dialog's history: a Blocks→Related conversion that
                      // displaces another pair is a replacement, while any
                      // conversion into Blocks keeps the Blocks wording.
                      relationRouteChangeKind(
                        { type: pendingTypeChange.nextType === 'related' ? 'related' : 'blocks' },
                        setConfirmationError.currentEffect,
                        [epicId, pendingTypeChange.target.id],
                      ),
                      setConfirmationError.currentEffect,
                      [
                        { id: epicId, title: epicTitle },
                        {
                          id: pendingTypeChange.target.id,
                          title: pendingTypeChange.target.title,
                        },
                      ],
                    )
                  : []),
                'Time already logged to a provider does not move.',
              ].join(' ')
            : ''
        }
        confirmText={
          isEpicRelationConfirmationError(setRelation.error)
            ? 'Accept route and change'
            : 'Change type'
        }
        cancelText="Cancel"
        loading={setRelation.isPending}
        onConfirm={confirmTypeChange}
      />
    </Card>
  );
}
