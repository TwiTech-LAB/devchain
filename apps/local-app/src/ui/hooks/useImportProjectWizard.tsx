import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchSetupPreview,
  type SetupPreviewRequest,
  type SetupPreviewResponse,
} from '@/ui/pages/projects/lib/project-api';
import {
  useProjectSetupWizard,
  type ProjectSetupWizardController,
  type WizardStep,
} from '@/ui/hooks/useProjectSetupWizard';
import {
  Step4Review,
  hasUnmappedStatuses,
  type ImportDryRunReview,
} from '@/ui/components/project/wizard/Step4Review';
import {
  buildConfigEmission,
  buildConfigSteps,
  initialWizardConfigState,
  useWizardConfigHandlers,
  type WizardConfigState,
} from '@/ui/components/project/wizard/useWizardConfig';

type ToastFn = (args: { title: string; description: string; variant?: 'destructive' }) => void;

export interface ImportWizardTarget {
  id: string;
  name: string;
}

export interface ImportDryRunResult {
  dryRun: true;
  missingProviders: string[];
  unmatchedStatuses?: Array<{ id: string; label: string; color: string; epicCount: number }>;
  templateStatuses?: Array<{ label: string; color: string }>;
  counts: { toImport: Record<string, number>; toDelete: Record<string, number> };
}

export interface ImportResult {
  success: boolean;
  counts: { imported: Record<string, number>; deleted: Record<string, number> };
  mappings: Record<string, Record<string, string>>;
  initialPromptSet?: boolean;
  message?: string;
}

/** Import wizard state = the shared Steps 1-3 config plus the import-only status mappings. */
interface ImportWizardState extends WizardConfigState {
  statusMappings: Record<string, string>;
}

interface UseImportProjectWizardArgs {
  /** Called with the commit result so the page can show the ImportResultDialog. */
  onImported: (result: ImportResult) => void;
  toast: ToastFn;
}

export interface ImportProjectWizardResult {
  isOpen: boolean;
  /** Open the import wizard for a target project + a resolved setup-preview request (template/file). */
  openImportWizard: (target: ImportWizardTarget, previewRequest: SetupPreviewRequest) => void;
  onOpenChange: (open: boolean) => void;
  controller: ProjectSetupWizardController;
  isLoading: boolean;
  isError: boolean;
  isSubmitting: boolean;
  preview: SetupPreviewResponse | null;
  importTarget: ImportWizardTarget | null;
}

/** Adapt the dry-run response to the Review component's shape (superset-compatible). */
function toReview(dry: ImportDryRunResult | null): ImportDryRunReview | null {
  if (!dry) return null;
  return {
    counts: dry.counts,
    unmatchedStatuses: dry.unmatchedStatuses,
    templateStatuses: dry.templateStatuses,
    missingProviders: dry.missingProviders,
  };
}

/**
 * Import-flow controller: the SAME wizard as create (Providers → Agents → Teams via the shared config
 * module) plus a final Review & Confirm step. On entering Review it re-runs the server dry-run with all
 * wizard selections (selectedProviderNames + familyProviderMappings + presetName|agentOverrides +
 * teamOverrides); the step shows the to-import/will-delete counts and, when the dry-run reports
 * unmatched statuses, a status-mapping section. The destructive commit fires ONLY from the wizard's
 * final submit, gated on the dry-run having loaded and every required status mapping being filled —
 * preserving today's destructive-counts confirmation. File imports arrive via `rawContent` in the
 * setup-preview request; template imports via slug/version.
 */
export function useImportProjectWizard({
  onImported,
  toast,
}: UseImportProjectWizardArgs): ImportProjectWizardResult {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [importTarget, setImportTarget] = useState<ImportWizardTarget | null>(null);
  const [previewRequest, setPreviewRequest] = useState<SetupPreviewRequest | null>(null);
  const [state, setState] = useState<ImportWizardState | null>(null);
  const [dryRun, setDryRun] = useState<ImportDryRunResult | null>(null);
  const [isDryRunPending, setIsDryRunPending] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const submittedRef = useRef(false);

  const previewQuery = useQuery({
    queryKey: ['setup-preview', previewRequest],
    queryFn: () => fetchSetupPreview(previewRequest!),
    enabled: isOpen && previewRequest !== null,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const preview = previewQuery.data ?? null;

  useEffect(() => {
    if (isOpen && preview && state === null) {
      setState({ ...initialWizardConfigState(preview), statusMappings: {} });
    }
  }, [isOpen, preview, state]);

  const handlers = useWizardConfigHandlers(preview, setState);

  const onStatusMappingChange = useCallback((statusId: string, templateLabel: string) => {
    setState((prev) =>
      prev
        ? { ...prev, statusMappings: { ...prev.statusMappings, [statusId]: templateLabel } }
        : prev,
    );
  }, []);

  const review = useMemo(() => toReview(dryRun), [dryRun]);
  const reviewReady =
    !isDryRunPending &&
    dryRun !== null &&
    !hasUnmappedStatuses(review, state?.statusMappings ?? {});

  const steps = useMemo<WizardStep[]>(() => {
    const configSteps = buildConfigSteps({ preview, state, handlers }).steps;
    return [
      ...configSteps,
      {
        id: 'review',
        title: 'Review',
        // The destructive commit is gated here: dry-run must have loaded and every required status
        // mapping must be filled before the final "Import" enables.
        canProceed: reviewReady,
        render: () =>
          state ? (
            <Step4Review
              review={review}
              isLoading={isDryRunPending || (dryRun === null && isOpen)}
              statusMappings={state.statusMappings}
              onStatusMappingChange={onStatusMappingChange}
            />
          ) : null,
      },
    ];
  }, [
    preview,
    state,
    handlers,
    review,
    reviewReady,
    isDryRunPending,
    dryRun,
    isOpen,
    onStatusMappingChange,
  ]);

  const closeWizard = useCallback(() => {
    setIsOpen(false);
  }, []);

  const importBody = useCallback(
    (extra?: Record<string, unknown>) => {
      if (!preview || !state) return null;
      // buildConfigEmission is the ONE shared emission path (config + familyProviderMappings),
      // so create and import cannot drift on Step-1 family mapping.
      return {
        ...(preview.payload as Record<string, unknown>),
        ...buildConfigEmission(preview, state),
        ...(extra ?? {}),
      };
    },
    [preview, state],
  );

  const runDryRun = useCallback(async () => {
    const body = importBody();
    if (!importTarget || !body) return;
    setIsDryRunPending(true);
    try {
      const res = await fetch(`/api/projects/${importTarget.id}/import?dryRun=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.message || 'Precheck failed');
      }
      setDryRun((await res.json()) as ImportDryRunResult);
    } catch (error) {
      toast({
        title: 'Import precheck failed',
        description: error instanceof Error ? error.message : 'Unable to compute changes',
        variant: 'destructive',
      });
    } finally {
      setIsDryRunPending(false);
    }
  }, [importBody, importTarget, toast]);

  const submit = useCallback(async () => {
    const body = importBody(
      state && Object.keys(state.statusMappings).length > 0
        ? { statusMappings: state.statusMappings }
        : undefined,
    );
    if (!importTarget || !body) return;
    submittedRef.current = true;
    setIsCommitting(true);
    try {
      const res = await fetch(`/api/projects/${importTarget.id}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let message = `Import failed with status ${res.status}`;
        try {
          message = (await res.json()).message || message;
        } catch {
          /* keep status-based message */
        }
        throw new Error(message);
      }
      const result = (await res.json()) as ImportResult;
      setIsOpen(false);
      toast({ title: 'Import complete', description: result.message || 'Project replaced.' });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      onImported(result);
    } catch (error) {
      toast({
        title: 'Import failed',
        description: error instanceof Error ? error.message : 'Unable to import project',
        variant: 'destructive',
      });
    } finally {
      setIsCommitting(false);
      submittedRef.current = false;
    }
  }, [importBody, importTarget, state, toast, queryClient, onImported]);

  const controller = useProjectSetupWizard({ steps, onSubmit: submit, onCancel: closeWizard });
  const { reset, currentStep } = controller;
  const currentStepId = currentStep?.id;

  // Run the dry-run whenever the user is on the Review step without a fresh result. Leaving Review
  // (Back) clears the stale result so returning after config edits recomputes with new selections.
  useEffect(() => {
    if (!isOpen) return;
    if (currentStepId === 'review') {
      if (dryRun === null && !isDryRunPending) void runDryRun();
    } else if (dryRun !== null) {
      setDryRun(null);
    }
  }, [isOpen, currentStepId, dryRun, isDryRunPending, runDryRun]);

  const openImportWizard = useCallback(
    (target: ImportWizardTarget, request: SetupPreviewRequest) => {
      submittedRef.current = false;
      setImportTarget(target);
      setPreviewRequest(request);
      setState(null);
      setDryRun(null);
      setIsDryRunPending(false);
      reset();
      setIsOpen(true);
    },
    [reset],
  );

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open) closeWizard();
    },
    [closeWizard],
  );

  const isError = previewQuery.isError;
  const isLoading = isOpen && !isError && (previewQuery.isLoading || state === null);

  return {
    isOpen,
    openImportWizard,
    onOpenChange,
    controller,
    isLoading,
    isError,
    isSubmitting: isCommitting,
    preview,
    importTarget,
  };
}
