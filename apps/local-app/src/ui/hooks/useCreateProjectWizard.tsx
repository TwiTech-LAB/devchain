import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  fetchSetupPreview,
  type SetupPreviewRequest,
  type SetupPreviewResponse,
} from '@/ui/pages/projects/lib/project-api';
import type { CreateFromTemplatePayload } from '@/ui/hooks/useTemplateForm';
import {
  useProjectSetupWizard,
  type ProjectSetupWizardController,
} from '@/ui/hooks/useProjectSetupWizard';
import {
  buildConfigEmission,
  buildConfigSteps,
  initialWizardConfigState,
  useWizardConfigHandlers,
  type WizardConfigState,
} from '@/ui/components/project/wizard/useWizardConfig';

/**
 * Domain state accumulated across the create wizard. Owned here (the flow controller), NOT by the
 * step components — Back/Next never lose it. This is exactly the shared Steps 1-3 config surface
 * (create adds no extra fields beyond it).
 */
export type CreateWizardState = WizardConfigState;

/** Minimal shape of the create mutation this hook drives. */
interface CreateMutationLike {
  mutate: (payload: CreateFromTemplatePayload) => void;
  isPending: boolean;
  isSuccess: boolean;
}

export interface CreateProjectWizardResult {
  isOpen: boolean;
  /** Open the wizard for a validated base payload (name/rootPath/template identity). */
  openWizard: (basePayload: CreateFromTemplatePayload) => void;
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

function toPreviewRequest(payload: CreateFromTemplatePayload): SetupPreviewRequest | null {
  if (payload.templatePath) return { templatePath: payload.templatePath };
  if (payload.templateId) {
    return { slug: payload.templateId, ...(payload.version ? { version: payload.version } : {}) };
  }
  return null;
}

/**
 * Create-flow controller composing the flow-agnostic step machine (`useProjectSetupWizard`) with:
 *  - a ONCE-per-session setup-preview fetch (react-query, cached + shared to every step),
 *  - the shared Steps 1-3 config state + handlers + step registration (`useWizardConfig`), and
 *  - the single final create mutation (base payload + selectedProviderNames + presetName XOR
 *    agentOverrides + teamOverrides).
 *
 * Nothing is created until the user confirms on the last step.
 */
export function useCreateProjectWizard(mutation: CreateMutationLike): CreateProjectWizardResult {
  const [isOpen, setIsOpen] = useState(false);
  const [basePayload, setBasePayload] = useState<CreateFromTemplatePayload | null>(null);
  const [state, setState] = useState<CreateWizardState | null>(null);
  const submittedRef = useRef(false);

  const previewRequest = useMemo(
    () => (basePayload ? toPreviewRequest(basePayload) : null),
    [basePayload],
  );

  const previewQuery = useQuery({
    queryKey: ['setup-preview', previewRequest],
    queryFn: () => fetchSetupPreview(previewRequest!),
    enabled: isOpen && previewRequest !== null,
    // One fetch per wizard session, shared to all steps — never refetch mid-flow.
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const preview = previewQuery.data ?? null;

  // Initialize the session state exactly once, when this session's preview lands.
  useEffect(() => {
    if (isOpen && preview && state === null) {
      setState(initialWizardConfigState(preview));
    }
  }, [isOpen, preview, state]);

  const handlers = useWizardConfigHandlers(preview, setState);

  const steps = useMemo(
    () => buildConfigSteps({ preview, state, handlers }).steps,
    [preview, state, handlers],
  );

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
    (payload: CreateFromTemplatePayload) => {
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
