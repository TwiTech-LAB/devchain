import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import {
  formatProjectPreMutationFailure,
  isProjectPreMutationFailure,
} from '@/ui/pages/projects/lib/project-failures';
import type {
  ImportDryRunResponse,
  ImportDryRunSuccess,
  ImportProjectSuccess,
  ProjectPreMutationFailure,
  SetupPreviewRequest,
  SetupPreviewResponse,
  UpgradeProjectFailure,
  UpgradeProjectResponse,
  UpgradeProjectSuccess,
} from '@/ui/pages/projects/lib/project-contracts';
import type { ProjectsPageApi } from '@/ui/pages/projects/lib/projects-page-api';
import { HOME_BACKEND, type BackendId } from '@/ui/lib/api-transport';
import { projectsHttpApi } from '@/ui/pages/projects/lib/projects-http-api';
import { projectsQueryKeys } from '@/ui/pages/projects/lib/project-query-keys';
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
import { formatPromptTransferCounts, type PromptTransferCounts } from '@/common/prompt-transfer';
import { Alert, AlertDescription, AlertTitle } from '@/ui/components/ui/alert';

type ToastFn = (args: { title: string; description: string; variant?: 'destructive' }) => void;

export interface ImportWizardTarget {
  id: string;
  name: string;
  /** Instance that owns the project; omitted means home. */
  backend?: BackendId;
}

export interface UpgradeWizardTarget extends ImportWizardTarget {
  targetVersion: string;
}

export type ImportDryRunResult = ImportDryRunSuccess;
export type ImportResult = ImportProjectSuccess;

interface ReplaceWizardState extends WizardConfigState {
  statusMappings: Record<string, string>;
}

interface ReplaceFlowAdapter<
  TTarget extends ImportWizardTarget,
  TSuccess extends { success: true },
> {
  name: 'Import' | 'Upgrade' | 'Update';
  previewQueryKey: (target: TTarget, request: SetupPreviewRequest | null) => QueryKey;
  canLoadPreview: (request: SetupPreviewRequest | null) => boolean;
  loadPreview: (
    target: TTarget,
    request: SetupPreviewRequest | null,
  ) => Promise<SetupPreviewResponse>;
  buildCommitBody: (
    target: TTarget,
    preview: SetupPreviewResponse,
    state: ReplaceWizardState,
  ) => Record<string, unknown>;
  commit: (
    target: TTarget,
    body: Record<string, unknown>,
  ) => Promise<TSuccess | ProjectPreMutationFailure | UpgradeProjectFailure>;
  isTerminalFailure: (failure: ProjectPreMutationFailure | UpgradeProjectFailure) => boolean;
  successDescription: (target: TTarget, result: TSuccess) => string;
  invalidateOnClose: QueryKey[];
  invalidateOnSuccess: QueryKey[];
}

interface ConfiguredReplaceWizardResult<TTarget extends ImportWizardTarget> {
  isOpen: boolean;
  openWizard: (target: TTarget, previewRequest?: SetupPreviewRequest) => void;
  onOpenChange: (open: boolean) => void;
  controller: ProjectSetupWizardController;
  isLoading: boolean;
  isError: boolean;
  isSubmitting: boolean;
  preview: SetupPreviewResponse | null;
  target: TTarget | null;
  preflightFailure: ProjectPreMutationFailure | null;
}

interface UseConfiguredReplaceWizardArgs<
  TTarget extends ImportWizardTarget,
  TSuccess extends { success: true },
> {
  adapter: ReplaceFlowAdapter<TTarget, TSuccess>;
  onCompleted: (result: TSuccess | UpgradeProjectFailure) => void;
  onClosed?: () => void;
  toast: ToastFn;
  api: ProjectsPageApi;
}

function toReview(dry: ImportDryRunResult | null): ImportDryRunReview | null {
  if (!dry) return null;
  return {
    counts: dry.counts,
    unmatchedStatuses: dry.unmatchedStatuses,
    templateStatuses: dry.templateStatuses,
    missingProviders: dry.missingProviders,
    promptTransfer: dry.promptTransfer,
  };
}

function withStatusMappings(
  body: Record<string, unknown>,
  statusMappings: Record<string, string>,
): Record<string, unknown> {
  return Object.keys(statusMappings).length > 0 ? { ...body, statusMappings } : body;
}

function buildConfiguredReplaceBody(
  preview: SetupPreviewResponse,
  state: ReplaceWizardState,
): Record<string, unknown> {
  return withStatusMappings(
    {
      ...(preview.payload as Record<string, unknown>),
      ...buildConfigEmission(preview, state),
    },
    state.statusMappings,
  );
}

function formatPromptSummary(promptTransfer?: PromptTransferCounts): string {
  return promptTransfer ? ` Prompts: ${formatPromptTransferCounts(promptTransfer)}.` : '';
}

function useConfiguredReplaceWizard<
  TTarget extends ImportWizardTarget,
  TSuccess extends { success: true },
>({
  adapter,
  onCompleted,
  onClosed,
  toast,
  api,
}: UseConfiguredReplaceWizardArgs<TTarget, TSuccess>): ConfiguredReplaceWizardResult<TTarget> {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [target, setTarget] = useState<TTarget | null>(null);
  const [previewRequest, setPreviewRequest] = useState<SetupPreviewRequest | null>(null);
  const [state, setState] = useState<ReplaceWizardState | null>(null);
  const [dryRun, setDryRun] = useState<ImportDryRunResult | null>(null);
  const [preflightFailure, setPreflightFailure] = useState<ProjectPreMutationFailure | null>(null);
  const [isDryRunPending, setIsDryRunPending] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);

  const previewQuery = useQuery({
    queryKey: target
      ? adapter.previewQueryKey(target, previewRequest)
      : ['configured-replace-preview', adapter.name, 'closed'],
    queryFn: () => adapter.loadPreview(target!, previewRequest),
    enabled: isOpen && target !== null && adapter.canLoadPreview(previewRequest),
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
    setState((previous) =>
      previous
        ? {
            ...previous,
            statusMappings: { ...previous.statusMappings, [statusId]: templateLabel },
          }
        : previous,
    );
  }, []);

  const review = useMemo(() => toReview(dryRun), [dryRun]);
  const reviewReady =
    !isDryRunPending &&
    dryRun !== null &&
    dryRun.readiness?.ready !== false &&
    preflightFailure === null &&
    !hasUnmappedStatuses(review, state?.statusMappings ?? {});

  const invalidate = useCallback(
    (queryKeys: QueryKey[]) => {
      for (const queryKey of queryKeys) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
    [queryClient],
  );

  const closeWizard = useCallback(() => {
    setIsOpen(false);
    invalidate(adapter.invalidateOnClose);
    onClosed?.();
  }, [adapter, invalidate, onClosed]);

  const dryRunBody = useCallback(() => {
    if (!preview || !state) return null;
    return buildConfiguredReplaceBody(preview, state);
  }, [preview, state]);

  const runDryRun = useCallback(async () => {
    const body = dryRunBody();
    if (!target || !body) return;
    setIsDryRunPending(true);
    setPreflightFailure(null);
    try {
      const result: ImportDryRunResponse = await api.runImportDryRun(
        target.id,
        body,
        target.backend,
      );
      if (result.dryRun !== true || !result.counts) {
        throw new Error('Precheck returned an invalid result');
      }
      setDryRun(result);
      if (isProjectPreMutationFailure(result)) {
        setPreflightFailure(result);
        toast({
          title: `${adapter.name} precheck failed`,
          description: formatProjectPreMutationFailure(result),
          variant: 'destructive',
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to compute changes';
      setPreflightFailure({
        success: false,
        mutationStarted: false,
        error: message,
      });
      toast({
        title: `${adapter.name} precheck failed`,
        description: message,
        variant: 'destructive',
      });
    } finally {
      setIsDryRunPending(false);
    }
  }, [adapter.name, api, dryRunBody, target, toast]);

  const submit = useCallback(async () => {
    if (!target || !preview || !state) return;
    const body = adapter.buildCommitBody(target, preview, state);
    setIsCommitting(true);
    try {
      const result = await adapter.commit(target, body);
      if (result.success === true) {
        setIsOpen(false);
        invalidate(adapter.invalidateOnSuccess);
        toast({
          title: `${adapter.name} complete`,
          description: adapter.successDescription(target, result),
        });
        onCompleted(result);
        return;
      }

      if (result.mutationStarted === false) {
        const failure: ProjectPreMutationFailure = {
          ...result,
          mutationStarted: false,
          error: result.error || `${adapter.name} could not start`,
        };
        setPreflightFailure(failure);
        toast({
          title: `${adapter.name} failed`,
          description: formatProjectPreMutationFailure(failure),
          variant: 'destructive',
        });
        return;
      }

      if (adapter.isTerminalFailure(result)) {
        setIsOpen(false);
        invalidate(adapter.invalidateOnSuccess);
        onCompleted(result);
        return;
      }
      throw new Error(result.error || `${adapter.name} returned an invalid failure result`);
    } catch (error) {
      toast({
        title: `${adapter.name} failed`,
        description: error instanceof Error ? error.message : `${adapter.name} failed`,
        variant: 'destructive',
      });
    } finally {
      setIsCommitting(false);
    }
  }, [adapter, invalidate, onCompleted, preview, state, target, toast]);

  const reviewStep = useMemo<WizardStep>(
    () => ({
      id: 'review',
      title: 'Review',
      canProceed: reviewReady,
      render: () =>
        state ? (
          <Fragment>
            {preflightFailure && (
              <Alert variant="destructive" role="alert" className="mb-3">
                <AlertTitle>{adapter.name} blocked before making changes</AlertTitle>
                <AlertDescription>
                  {formatProjectPreMutationFailure(preflightFailure)}
                </AlertDescription>
              </Alert>
            )}
            {(review || !preflightFailure) && (
              <Step4Review
                review={review}
                isLoading={isDryRunPending || (dryRun === null && isOpen)}
                statusMappings={state.statusMappings}
                onStatusMappingChange={onStatusMappingChange}
                operationName={adapter.name.toLowerCase()}
              />
            )}
          </Fragment>
        ) : null,
    }),
    [
      adapter.name,
      dryRun,
      isDryRunPending,
      isOpen,
      onStatusMappingChange,
      preflightFailure,
      review,
      reviewReady,
      state,
    ],
  );

  const steps = useMemo<WizardStep[]>(
    () => [...buildConfigSteps({ preview, state, handlers }).steps, reviewStep],
    [handlers, preview, reviewStep, state],
  );

  const controller = useProjectSetupWizard({ steps, onSubmit: submit, onCancel: closeWizard });
  const { currentStep, reset } = controller;
  const currentStepId = currentStep?.id;

  useEffect(() => {
    if (!isOpen) return;
    if (currentStepId === 'review') {
      if (dryRun === null && preflightFailure === null && !isDryRunPending) void runDryRun();
    } else if (dryRun !== null || preflightFailure !== null) {
      setDryRun(null);
      setPreflightFailure(null);
    }
  }, [currentStepId, dryRun, isDryRunPending, isOpen, preflightFailure, runDryRun]);

  const openWizard = useCallback(
    (nextTarget: TTarget, request?: SetupPreviewRequest) => {
      setTarget(nextTarget);
      setPreviewRequest(request ?? null);
      setState(null);
      setDryRun(null);
      setPreflightFailure(null);
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
    openWizard,
    onOpenChange,
    controller,
    isLoading,
    isError,
    isSubmitting: isCommitting,
    preview,
    target,
    preflightFailure,
  };
}

function importAdapter(
  api: ProjectsPageApi,
): ReplaceFlowAdapter<ImportWizardTarget, ImportProjectSuccess> {
  return {
    name: 'Import',
    previewQueryKey: (_target, request) => projectsQueryKeys.setupPreview(request),
    canLoadPreview: (request) => request !== null,
    loadPreview: (_target, request) => api.loadSetupPreview(request!),
    buildCommitBody: (_target, preview, state) => buildConfiguredReplaceBody(preview, state),
    commit: (target, body) => api.commitImport(target.id, body),
    isTerminalFailure: () => false,
    successDescription: (_target, result) => {
      return `${result.message || 'Project replaced.'}${formatPromptSummary(result.promptTransfer)}`;
    },
    invalidateOnClose: [],
    invalidateOnSuccess: [projectsQueryKeys.all()],
  };
}

function upgradeAdapter(
  actionName: 'Upgrade' | 'Update',
  api: ProjectsPageApi,
): ReplaceFlowAdapter<UpgradeWizardTarget, UpgradeProjectSuccess> {
  return {
    name: actionName,
    previewQueryKey: (target) =>
      projectsQueryKeys.upgradePreview(
        target.id,
        target.targetVersion,
        target.backend ?? HOME_BACKEND,
      ),
    canLoadPreview: () => true,
    loadPreview: (target) =>
      api.loadUpgradePreview(target.id, target.targetVersion, target.backend),
    buildCommitBody: (target, preview, state) =>
      withStatusMappings(
        {
          targetVersion: target.targetVersion,
          ...buildConfigEmission(preview, state),
        },
        state.statusMappings,
      ),
    commit: (target, body) => api.commitUpgrade(target.id, body, target.backend),
    isTerminalFailure: (failure) => failure.mutationStarted !== false,
    successDescription: (target, result) => {
      return `${target.name} ${actionName === 'Upgrade' ? 'upgraded' : 'updated'} to v${result.newVersion}.${formatPromptSummary(result.promptTransfer)}`;
    },
    invalidateOnClose: [projectsQueryKeys.all(), projectsQueryKeys.templatesForUpgrade()],
    invalidateOnSuccess: [projectsQueryKeys.all(), projectsQueryKeys.templatesForUpgrade()],
  };
}

interface UseImportProjectWizardArgs {
  onImported: (result: ImportResult) => void;
  toast: ToastFn;
  api?: ProjectsPageApi;
}

export interface ImportProjectWizardResult
  extends Omit<ConfiguredReplaceWizardResult<ImportWizardTarget>, 'openWizard' | 'target'> {
  openImportWizard: (target: ImportWizardTarget, previewRequest: SetupPreviewRequest) => void;
  importTarget: ImportWizardTarget | null;
}

export function useImportProjectWizard({
  onImported,
  toast,
  api = projectsHttpApi,
}: UseImportProjectWizardArgs): ImportProjectWizardResult {
  const adapter = useMemo(() => importAdapter(api), [api]);
  const wizard = useConfiguredReplaceWizard({
    adapter,
    onCompleted: (result) => {
      if (result.success) onImported(result);
    },
    toast,
    api,
  });
  return {
    ...wizard,
    openImportWizard: wizard.openWizard,
    importTarget: wizard.target,
  };
}

interface UseUpgradeProjectWizardArgs {
  actionName: 'Upgrade' | 'Update';
  onFinished: (result: UpgradeProjectResponse) => void;
  onClosed: () => void;
  toast: ToastFn;
  api?: ProjectsPageApi;
}

export interface UpgradeProjectWizardResult
  extends Omit<ConfiguredReplaceWizardResult<UpgradeWizardTarget>, 'openWizard' | 'target'> {
  openUpgradeWizard: (target: UpgradeWizardTarget) => void;
  upgradeTarget: UpgradeWizardTarget | null;
}

export function useUpgradeProjectWizard({
  actionName,
  onFinished,
  onClosed,
  toast,
  api = projectsHttpApi,
}: UseUpgradeProjectWizardArgs): UpgradeProjectWizardResult {
  const adapter = useMemo(() => upgradeAdapter(actionName, api), [actionName, api]);
  const wizard = useConfiguredReplaceWizard({
    adapter,
    onCompleted: onFinished,
    onClosed,
    toast,
    api,
  });
  return {
    ...wizard,
    openUpgradeWizard: wizard.openWizard,
    upgradeTarget: wizard.target,
  };
}
