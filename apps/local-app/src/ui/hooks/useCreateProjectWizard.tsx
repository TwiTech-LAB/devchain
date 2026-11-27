import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import type {
  CreateFromTemplateInput,
  SetupPreviewRequest,
  SetupPreviewResponse,
} from '@/ui/pages/projects/lib/project-contracts';
import { projectsQueryKeys } from '@/ui/pages/projects/lib/project-query-keys';
import type { ProjectsPageApi } from '@/ui/pages/projects/lib/projects-page-api';
import { projectsHttpApi } from '@/ui/pages/projects/lib/projects-http-api';
import { HOME_BACKEND } from '@/ui/lib/api-transport';
import {
  useProjectSetupWizard,
  type ProjectSetupWizardController,
  type WizardStep,
} from '@/ui/hooks/useProjectSetupWizard';
import { CreateReview } from '@/ui/components/project/wizard/SetupReview';
import { HowItWorks, findHowItWorksGuide } from '@/ui/components/project/wizard/HowItWorks';
import {
  buildConfigEmission,
  buildSetupStep,
  initialWizardConfigState,
  useWizardConfigHandlers,
  type WizardConfigState,
} from '@/ui/components/project/wizard/useWizardConfig';

/**
 * Domain state accumulated across the create wizard. Owned here (the flow controller), NOT by the
 * step components — Back/Next never lose it. This is exactly the shared setup state (create adds
 * no extra fields beyond it).
 */
export type CreateWizardState = WizardConfigState;

/** Minimal shape of the create mutation this hook drives. */
interface CreateMutationLike {
  mutate: (payload: CreateFromTemplateInput) => void;
  isPending: boolean;
  isSuccess: boolean;
}

export interface CreateProjectWizardResult {
  isOpen: boolean;
  /** Open the wizard for a validated base payload (name/rootPath/template identity). */
  openWizard: (basePayload: CreateFromTemplateInput) => void;
  onOpenChange: (open: boolean) => void;
  controller: ProjectSetupWizardController;
  /** True while the setup-preview is loading or the session state is initializing. */
  isLoading: boolean;
  /** True when the setup-preview fetch failed. */
  isError: boolean;
  /** True while the final create mutation is in flight. */
  isSubmitting: boolean;
  /** The shared, once-per-session setup-preview (null until loaded). */
  preview: SetupPreviewResponse | null;
}

export function toPreviewRequest(
  payload: Pick<CreateFromTemplateInput, 'templatePath' | 'templateId' | 'version'>,
): SetupPreviewRequest | null {
  if (payload.templatePath) return { templatePath: payload.templatePath };
  if (payload.templateId) {
    return { slug: payload.templateId, ...(payload.version ? { version: payload.version } : {}) };
  }
  return null;
}

/**
 * The setup-preview query of the Create dialog and the create wizard. One key and one set of
 * options, so the wizard reads the dialog's fetch: one fetch per opening, never a refetch mid-flow.
 */
export function setupPreviewQueryOptions(
  api: ProjectsPageApi,
  request: SetupPreviewRequest | null,
) {
  return queryOptions({
    queryKey: projectsQueryKeys.setupPreview(request, HOME_BACKEND),
    queryFn: () => api.loadSetupPreview(request!),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/**
 * Create-flow controller composing the flow-agnostic step machine (`useProjectSetupWizard`) with:
 *  - a ONCE-per-session setup-preview fetch (react-query, cached + shared to every step),
 *  - the template's "How it works" guide step (skipped when the template has none),
 *  - the shared setup state + handlers + "Review setup" step (`useWizardConfig`), and
 *  - the single final create mutation (base payload + selectedProviderNames + presetName XOR
 *    agentOverrides + teamOverrides).
 *
 * Nothing is created until the user confirms on the last step.
 */
export function useCreateProjectWizard(
  mutation: CreateMutationLike,
  api: ProjectsPageApi = projectsHttpApi,
): CreateProjectWizardResult {
  const [isOpen, setIsOpen] = useState(false);
  const [basePayload, setBasePayload] = useState<CreateFromTemplateInput | null>(null);
  const [state, setState] = useState<CreateWizardState | null>(null);
  const submittedRef = useRef(false);

  const previewRequest = useMemo(
    () => (basePayload ? toPreviewRequest(basePayload) : null),
    [basePayload],
  );

  const previewQuery = useQuery({
    ...setupPreviewQueryOptions(api, previewRequest),
    enabled: isOpen && previewRequest !== null,
  });
  const preview = previewQuery.data ?? null;

  // Initialize the session state exactly once, when this session's preview lands.
  useEffect(() => {
    if (isOpen && preview && state === null) {
      setState(initialWizardConfigState(preview));
    }
  }, [isOpen, preview, state]);

  const handlers = useWizardConfigHandlers(preview, setState);

  const steps = useMemo<WizardStep[]>(() => {
    const guide = preview ? findHowItWorksGuide(preview.payload) : null;
    return [
      {
        id: 'how-it-works',
        title: 'How it works',
        skipped: guide === null,
        render: () => (guide ? <HowItWorks content={guide} /> : null),
      },
      buildSetupStep({ preview, state, handlers, Review: CreateReview, backend: HOME_BACKEND }),
    ];
  }, [preview, state, handlers]);

  const submit = useCallback(() => {
    if (!basePayload || !state) return;
    submittedRef.current = true;
    mutation.mutate({ ...basePayload, ...buildConfigEmission(preview, state) });
  }, [basePayload, state, preview, mutation]);

  const closeWizard = useCallback(() => {
    setIsOpen(false);
  }, []);

  const controller = useProjectSetupWizard({ steps, onSubmit: submit, onCancel: closeWizard });
  const { reset } = controller;

  const openWizard = useCallback(
    (payload: CreateFromTemplateInput) => {
      submittedRef.current = false;
      setBasePayload(payload);
      setState(null);
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

  // Close the wizard once OUR submission resolves successfully (a providerMappingRequired response
  // is also a success — the mapping modal then takes over). Errors keep the wizard open for retry.
  useEffect(() => {
    if (submittedRef.current && mutation.isSuccess) {
      submittedRef.current = false;
      setIsOpen(false);
    }
  }, [mutation.isSuccess]);

  const isError = previewQuery.isError;
  const isLoading = isOpen && !isError && (previewQuery.isLoading || state === null);

  return {
    isOpen,
    openWizard,
    onOpenChange,
    controller,
    isLoading,
    isError,
    isSubmitting: mutation.isPending,
    preview,
  };
}
