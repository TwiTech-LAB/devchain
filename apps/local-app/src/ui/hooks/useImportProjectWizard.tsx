import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { ExportData } from '@devchain/shared';
import type { PreserveTeamSetup } from '@/common/project-preservation.contract';
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
  ReplacePrecheckProvider,
  type ReplacePrecheckValue,
} from '@/ui/components/project/wizard/ReplacePrecheck';
import {
  buildConfigEmission,
  buildSetupStep,
  initialWizardConfigState,
  selectedProvidersEmission,
  useWizardConfigHandlers,
  wizardConfigStateFor,
  type ConfigEmission,
  type WizardConfigHandlers,
  type WizardConfigState,
} from '@/ui/components/project/wizard/useWizardConfig';
import { ReplaceReview } from '@/ui/components/project/wizard/SetupReview';
import {
  CurrentSetupProvider,
  type CurrentSetupValue,
} from '@/ui/components/project/wizard/KeepCurrentSetup';
import { canPreserveTeams } from '@/ui/components/project/wizard/currentSetup';
import { formatPromptTransferCounts, type PromptTransferCounts } from '@/common/prompt-transfer';

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

export type ImportResult = ImportProjectSuccess;

interface ReplaceWizardState extends WizardConfigState {
  currentExport: ExportData | null;
  keepCurrentSelected: boolean;
  preserveTeamSetup: PreserveTeamSetup;
}

function buildReplaceConfigEmission(
  preview: SetupPreviewResponse,
  state: ReplaceWizardState,
):
  | ConfigEmission
  | ({ preserveTeamSetup: PreserveTeamSetup } & Pick<ConfigEmission, 'selectedProviderNames'>) {
  if (!state.keepCurrentSelected) return buildConfigEmission(preview, state);
  return { preserveTeamSetup: state.preserveTeamSetup, ...selectedProvidersEmission(state) };
}

function initialReplaceState(
  preview: SetupPreviewResponse,
  currentExport: ExportData | null,
): ReplaceWizardState {
  return {
    ...initialWizardConfigState(preview, true, currentExport),
    currentExport,
    keepCurrentSelected: canPreserveTeams(currentExport),
    preserveTeamSetup: {},
  };
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

function buildConfiguredReplaceBody(
  preview: SetupPreviewResponse,
  state: ReplaceWizardState,
): Record<string, unknown> {
  return {
    ...preview.payload,
    ...buildReplaceConfigEmission(preview, state),
  };
}

function currentExportKey(target: ImportWizardTarget | null): QueryKey {
  return target
    ? projectsQueryKeys.currentExport(target.id, target.backend ?? HOME_BACKEND)
    : ['project-current-export', 'closed'];
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
  const [dryRun, setDryRun] = useState<ImportDryRunSuccess | null>(null);
  const [preflightFailure, setPreflightFailure] = useState<ProjectPreMutationFailure | null>(null);
  const [isDryRunPending, setIsDryRunPending] = useState(false);
  const [checkedBody, setCheckedBody] = useState<Record<string, unknown> | null>(null);
  const [isCommitting, setIsCommitting] = useState(false);
  // Each precheck run and each opening takes a new number. A result is used only when its number
  // is still the newest, so a slow result of an earlier project or run is ignored.
  const precheckRunRef = useRef(0);

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

  // The current setup is read once per open (openWizard drops the cached copy); edits never
  // reload it. A failed read leaves only the template's setups.
  const currentExportQuery = useQuery({
    queryKey: currentExportKey(target),
    queryFn: () => api.loadProjectExport(target!.id, target!.backend),
    enabled: isOpen && target !== null,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const currentExportSettled = currentExportQuery.isSuccess || currentExportQuery.isError;

  useEffect(() => {
    if (isOpen && preview && currentExportSettled && state === null) {
      setState(initialReplaceState(preview, currentExportQuery.data ?? null));
    }
  }, [isOpen, preview, currentExportSettled, currentExportQuery.data, state]);

  const configHandlers = useWizardConfigHandlers(preview, setState);
  const handlers = useMemo<WizardConfigHandlers>(
    () => ({
      ...configHandlers,
      onSelectedProvidersChange: (next) => {
        if (next.length === 0) return;
        setState((prev) => {
          if (!prev?.preserveTeamSetup.agentOptions) return prev;
          const { agentOptions, ...preserveTeamSetup } = prev.preserveTeamSetup;
          return { ...prev, preserveTeamSetup };
        });
        configHandlers.onSelectedProvidersChange(next);
      },
      onApplyPreset: (name) => {
        setState((prev) => (prev ? { ...prev, keepCurrentSelected: false } : prev));
        configHandlers.onApplyPreset(name);
      },
    }),
    [configHandlers],
  );

  const onKeepCurrentSetup = useCallback(() => {
    setState((prev) =>
      prev && !prev.keepCurrentSelected && canPreserveTeams(prev.currentExport)
        ? { ...prev, keepCurrentSelected: true }
        : prev,
    );
  }, []);

  const onUseTemplateSetup = useCallback(() => {
    if (!preview) return;
    setState(
      (prev) =>
        prev && {
          ...prev,
          ...wizardConfigStateFor(preview, prev.selectedProviderNames, {
            useSuggestedPreset: false,
          }),
          keepCurrentSelected: false,
        },
    );
  }, [preview]);

  const updateChoices = useCallback((update: (choices: PreserveTeamSetup) => PreserveTeamSetup) => {
    setState((prev) =>
      prev?.keepCurrentSelected
        ? { ...prev, preserveTeamSetup: update(prev.preserveTeamSetup) }
        : prev,
    );
  }, []);

  const invalidate = useCallback(
    (queryKeys: QueryKey[]) => {
      for (const queryKey of queryKeys) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
    [queryClient],
  );

  const closeWizard = useCallback(() => {
    precheckRunRef.current += 1;
    setIsOpen(false);
    invalidate(adapter.invalidateOnClose);
    onClosed?.();
  }, [adapter, invalidate, onClosed]);

  const dryRunBody = useMemo(() => {
    if (!preview || !state) return null;
    return buildConfiguredReplaceBody(preview, state);
  }, [preview, state]);

  const runDryRun = useCallback(async () => {
    if (!target || !dryRunBody || !state || !isOpen) return;
    const run = ++precheckRunRef.current;
    const isCurrent = () => run === precheckRunRef.current;
    setIsDryRunPending(true);
    setPreflightFailure(null);
    try {
      const result: ImportDryRunResponse = await api.runImportDryRun(
        target.id,
        dryRunBody,
        target.backend,
      );
      if (!isCurrent()) return;
      if (result.dryRun !== true || !result.counts) {
        throw new Error('Precheck returned an invalid result');
      }
      if (state.keepCurrentSelected && (!result.preservationPlan || !result.readiness)) {
        throw new Error('The server did not return a preserved roster check');
      }
      setDryRun(result);
      if (isProjectPreMutationFailure(result)) {
        setPreflightFailure(result);
      } else if (result.readiness?.ready === false) {
        setPreflightFailure({
          success: false,
          mutationStarted: false,
          error: 'The project is not ready to be replaced',
          readiness: result.readiness,
        });
      }
    } catch (error) {
      if (!isCurrent()) return;
      setDryRun(null);
      setPreflightFailure({
        success: false,
        mutationStarted: false,
        error: error instanceof Error ? error.message : 'Unable to compute changes',
      });
    } finally {
      if (isCurrent()) {
        setCheckedBody(dryRunBody);
        setIsDryRunPending(false);
      }
    }
  }, [api, dryRunBody, isOpen, state, target]);

  useEffect(() => {
    void runDryRun();
    return () => {
      precheckRunRef.current += 1;
    };
  }, [runDryRun]);

  const isFresh = checkedBody === dryRunBody;
  const currentFailure = isFresh ? preflightFailure : null;
  const isReviewCurrent = isFresh && !isDryRunPending && dryRun !== null;
  const reviewReady =
    isOpen &&
    isReviewCurrent &&
    (state?.keepCurrentSelected
      ? dryRun.readiness?.ready === true
      : dryRun.readiness?.ready !== false) &&
    currentFailure === null;

  const submit = useCallback(async () => {
    if (!target || !preview || !state || !reviewReady || isCommitting) return;
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
        if (failure.preservationPlan) {
          const plan = failure.preservationPlan;
          setDryRun((previous) => (previous ? { ...previous, preservationPlan: plan } : previous));
        }
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
  }, [adapter, invalidate, isCommitting, onCompleted, preview, reviewReady, state, target, toast]);

  const checkAgain = useCallback(() => void runDryRun(), [runDryRun]);

  const precheck = useMemo<ReplacePrecheckValue>(
    () => ({
      operationName: adapter.name,
      isPending: isDryRunPending || !isFresh,
      failure: currentFailure,
      onCheckAgain: checkAgain,
    }),
    [adapter.name, checkAgain, currentFailure, isDryRunPending, isFresh],
  );

  const currentSetup: CurrentSetupValue = {
    currentExport: state?.currentExport ?? null,
    selected: state?.keepCurrentSelected ?? false,
    onKeep: onKeepCurrentSetup,
    onUseTemplate: onUseTemplateSetup,
    plan: state?.keepCurrentSelected ? dryRun?.preservationPlan : undefined,
    isReviewCurrent,
    choices: state?.preserveTeamSetup ?? {},
    onUpdateChoices: updateChoices,
  };

  const step = buildSetupStep({
    preview,
    state,
    handlers,
    Review: ReplaceReview,
    currentExport: state?.currentExport,
    validateTemplateAgents: !state?.keepCurrentSelected,
  });
  const steps: WizardStep[] = [
    {
      ...step,
      description: 'Review the project setup before replacing it.',
      canProceed: step.canProceed !== false && reviewReady,
      render: () => (
        <ReplacePrecheckProvider value={precheck}>
          <CurrentSetupProvider value={currentSetup}>{step.render()}</CurrentSetupProvider>
        </ReplacePrecheckProvider>
      ),
    },
  ];

  const controller = useProjectSetupWizard({ steps, onSubmit: submit, onCancel: closeWizard });
  const { reset } = controller;

  const openWizard = useCallback(
    (nextTarget: TTarget, request?: SetupPreviewRequest) => {
      precheckRunRef.current += 1;
      queryClient.removeQueries({ queryKey: currentExportKey(nextTarget), exact: true });
      // The preview holds the installed providers; read it again for each opening.
      queryClient.removeQueries({
        queryKey: adapter.previewQueryKey(nextTarget, request ?? null),
        exact: true,
      });
      setTarget(nextTarget);
      setPreviewRequest(request ?? null);
      setState(null);
      setDryRun(null);
      setPreflightFailure(null);
      setIsDryRunPending(false);
      setCheckedBody(null);
      reset();
      setIsOpen(true);
    },
    [adapter, queryClient, reset],
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
    preflightFailure: currentFailure,
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
    buildCommitBody: (target, preview, state) => ({
      targetVersion: target.targetVersion,
      ...buildReplaceConfigEmission(preview, state),
    }),
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
