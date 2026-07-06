import { useCallback, useMemo, useState, type ReactNode } from 'react';

/**
 * A single wizard step. `skipped` and `canProceed` are recomputed by the flow controller on every
 * render from the (flow-owned) wizard state — this hook is a PURE step machine and never inspects
 * step content or cross-step state itself. Step components own NO cross-step state (composition
 * state-lift rule): the flow controller lifts it and passes derived booleans down here.
 */
export interface WizardStep {
  /** Stable identifier (used as React key + for the step indicator). */
  id: string;
  /** Short label shown in the step indicator (e.g. "Providers"). */
  title: string;
  /** Optional step-specific dialog description; the shell falls back to the flow-level one. */
  description?: string;
  /**
   * When true the step is hidden entirely — not rendered, not counted, not reachable. Derive from
   * SESSION-STABLE data (e.g. "template has no configurable teams"), not from values the user
   * mutates while navigating, so the visible-step indexing does not shift underfoot.
   */
  skipped?: boolean;
  /** Gate the Next/Create action for this step. Defaults to true when omitted. */
  canProceed?: boolean;
  /** Render the step body. Content is supplied by the flow (create: Tasks 5-7). */
  render: () => ReactNode;
}

export interface UseProjectSetupWizardArgs {
  /** Ordered steps for the active flow (create supplies Providers/Agents/Teams). */
  steps: WizardStep[];
  /** Fired when the user confirms on the LAST visible step (the single final mutation). */
  onSubmit: () => void;
  /** Fired on Cancel — MUST NOT create anything (no API mutation). */
  onCancel: () => void;
}

export interface ProjectSetupWizardController {
  /** Visible (non-skipped) steps, in order. */
  visibleSteps: WizardStep[];
  /** The active step, or undefined when there are no visible steps. */
  currentStep: WizardStep | undefined;
  /** Zero-based index of the active step within `visibleSteps`. */
  currentIndex: number;
  /** Count of visible steps. */
  totalSteps: number;
  isFirstStep: boolean;
  isLastStep: boolean;
  /** Whether the active step permits advancing/submitting (its `canProceed`, default true). */
  canProceed: boolean;
  /** Advance to the next visible step (no-op on the last step or when gated). */
  goNext: () => void;
  /** Return to the previous visible step, preserving all state (no-op on the first step). */
  goBack: () => void;
  /** Confirm on the last step → fires `onSubmit` (no-op unless on the last step and allowed). */
  submit: () => void;
  /** Cancel the wizard → fires `onCancel` (creates nothing). */
  cancel: () => void;
  /** Reset navigation to the first step (call when (re)opening a wizard session). */
  reset: () => void;
}

/**
 * Flow-agnostic wizard step machine: owns ONLY the navigation cursor. The flow controller owns the
 * domain wizard state and feeds in `steps` with per-render `skipped`/`canProceed` booleans; Back
 * preserves all state because this hook never touches it. Skipped steps are excluded from ordering,
 * gating, and the first/last computation so predicate-driven skipping (e.g. Teams when a template
 * has no configurable teams) behaves as if the step never existed.
 */
export function useProjectSetupWizard({
  steps,
  onSubmit,
  onCancel,
}: UseProjectSetupWizardArgs): ProjectSetupWizardController {
  const [rawIndex, setRawIndex] = useState(0);

  const visibleSteps = useMemo(() => steps.filter((step) => !step.skipped), [steps]);

  const totalSteps = visibleSteps.length;
  // Clamp defensively so a shrinking visible list (should not happen mid-flow, but guard anyway)
  // never points past the end.
  const currentIndex = totalSteps === 0 ? 0 : Math.min(rawIndex, totalSteps - 1);
  const currentStep = visibleSteps[currentIndex];

  const isFirstStep = currentIndex <= 0;
  const isLastStep = totalSteps === 0 || currentIndex >= totalSteps - 1;
  const canProceed = currentStep?.canProceed ?? true;

  const goNext = useCallback(() => {
    setRawIndex((prev) => {
      const clamped = totalSteps === 0 ? 0 : Math.min(prev, totalSteps - 1);
      const active = visibleSteps[clamped];
      // Respect the CURRENT step's gate; never advance past the last visible step.
      if ((active?.canProceed ?? true) && clamped < totalSteps - 1) {
        return clamped + 1;
      }
      return clamped;
    });
  }, [totalSteps, visibleSteps]);

  const goBack = useCallback(() => {
    setRawIndex((prev) => (prev <= 0 ? 0 : prev - 1));
  }, []);

  const submit = useCallback(() => {
    const clamped = totalSteps === 0 ? 0 : Math.min(rawIndex, totalSteps - 1);
    const active = visibleSteps[clamped];
    const onLast = totalSteps === 0 || clamped >= totalSteps - 1;
    if (onLast && (active?.canProceed ?? true)) {
      onSubmit();
    }
  }, [rawIndex, totalSteps, visibleSteps, onSubmit]);

  const cancel = useCallback(() => {
    onCancel();
  }, [onCancel]);

  const reset = useCallback(() => {
    setRawIndex(0);
  }, []);

  return {
    visibleSteps,
    currentStep,
    currentIndex,
    totalSteps,
    isFirstStep,
    isLastStep,
    canProceed,
    goNext,
    goBack,
    submit,
    cancel,
    reset,
  };
}
