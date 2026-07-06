import { act, renderHook } from '@testing-library/react';
import { useProjectSetupWizard, type WizardStep } from './useProjectSetupWizard';

/** Build a fresh 3-step create-shaped list; per-step flags overridable. */
function makeSteps(
  over: Partial<Record<'providers' | 'agents' | 'teams', Partial<WizardStep>>> = {},
): WizardStep[] {
  return [
    { id: 'providers', title: 'Providers', render: () => null, ...over.providers },
    { id: 'agents', title: 'Agents', render: () => null, ...over.agents },
    { id: 'teams', title: 'Teams', render: () => null, ...over.teams },
  ];
}

describe('useProjectSetupWizard', () => {
  it('exposes visible steps in order and starts on the first step', () => {
    const { result } = renderHook(() =>
      useProjectSetupWizard({ steps: makeSteps(), onSubmit: jest.fn(), onCancel: jest.fn() }),
    );

    expect(result.current.visibleSteps.map((s) => s.id)).toEqual(['providers', 'agents', 'teams']);
    expect(result.current.currentStep?.id).toBe('providers');
    expect(result.current.currentIndex).toBe(0);
    expect(result.current.totalSteps).toBe(3);
    expect(result.current.isFirstStep).toBe(true);
    expect(result.current.isLastStep).toBe(false);
  });

  it('Next advances through steps and reaches the last step', () => {
    const { result } = renderHook(() =>
      useProjectSetupWizard({ steps: makeSteps(), onSubmit: jest.fn(), onCancel: jest.fn() }),
    );

    act(() => result.current.goNext());
    expect(result.current.currentStep?.id).toBe('agents');
    expect(result.current.isFirstStep).toBe(false);

    act(() => result.current.goNext());
    expect(result.current.currentStep?.id).toBe('teams');
    expect(result.current.isLastStep).toBe(true);

    // Next on the last step does not advance (and never submits).
    act(() => result.current.goNext());
    expect(result.current.currentStep?.id).toBe('teams');
  });

  it('Back returns to the previous step, preserving position', () => {
    const { result } = renderHook(() =>
      useProjectSetupWizard({ steps: makeSteps(), onSubmit: jest.fn(), onCancel: jest.fn() }),
    );

    act(() => result.current.goNext());
    act(() => result.current.goNext());
    expect(result.current.currentStep?.id).toBe('teams');

    act(() => result.current.goBack());
    expect(result.current.currentStep?.id).toBe('agents');
    act(() => result.current.goBack());
    expect(result.current.currentStep?.id).toBe('providers');
    // Back on the first step is a no-op.
    act(() => result.current.goBack());
    expect(result.current.currentStep?.id).toBe('providers');
  });

  it('gates Next when the active step cannot proceed', () => {
    const { result, rerender } = renderHook(
      (props: { steps: WizardStep[] }) =>
        useProjectSetupWizard({ steps: props.steps, onSubmit: jest.fn(), onCancel: jest.fn() }),
      { initialProps: { steps: makeSteps({ providers: { canProceed: false } }) } },
    );

    expect(result.current.canProceed).toBe(false);
    act(() => result.current.goNext());
    // Still on providers — the gate blocked advancement.
    expect(result.current.currentStep?.id).toBe('providers');

    // Flip the gate on (as the flow controller would after the user selects a provider).
    rerender({ steps: makeSteps({ providers: { canProceed: true } }) });
    expect(result.current.canProceed).toBe(true);
    act(() => result.current.goNext());
    expect(result.current.currentStep?.id).toBe('agents');
  });

  it('skips steps by predicate and treats the last visible step as last', () => {
    const { result } = renderHook(() =>
      useProjectSetupWizard({
        steps: makeSteps({ teams: { skipped: true } }),
        onSubmit: jest.fn(),
        onCancel: jest.fn(),
      }),
    );

    expect(result.current.visibleSteps.map((s) => s.id)).toEqual(['providers', 'agents']);
    expect(result.current.totalSteps).toBe(2);

    act(() => result.current.goNext());
    expect(result.current.currentStep?.id).toBe('agents');
    // Agents is now the last visible step (teams skipped).
    expect(result.current.isLastStep).toBe(true);
  });

  it('advances past a skipped middle step', () => {
    const { result } = renderHook(() =>
      useProjectSetupWizard({
        steps: makeSteps({ agents: { skipped: true } }),
        onSubmit: jest.fn(),
        onCancel: jest.fn(),
      }),
    );

    expect(result.current.visibleSteps.map((s) => s.id)).toEqual(['providers', 'teams']);
    act(() => result.current.goNext());
    expect(result.current.currentStep?.id).toBe('teams');
  });

  it('submit only fires onSubmit on the last step (nothing created mid-flow)', () => {
    const onSubmit = jest.fn();
    const { result } = renderHook(() =>
      useProjectSetupWizard({ steps: makeSteps(), onSubmit, onCancel: jest.fn() }),
    );

    // Not on the last step → submit is a no-op.
    act(() => result.current.submit());
    expect(onSubmit).not.toHaveBeenCalled();

    act(() => result.current.goNext());
    act(() => result.current.goNext());
    expect(result.current.isLastStep).toBe(true);
    act(() => result.current.submit());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('does not submit on the last step while gated', () => {
    const onSubmit = jest.fn();
    const { result } = renderHook(() =>
      useProjectSetupWizard({
        // Only one visible step, gated closed → last step but cannot proceed.
        steps: makeSteps({
          providers: { canProceed: false },
          agents: { skipped: true },
          teams: { skipped: true },
        }),
        onSubmit,
        onCancel: jest.fn(),
      }),
    );

    expect(result.current.isLastStep).toBe(true);
    expect(result.current.canProceed).toBe(false);
    act(() => result.current.submit());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('cancel fires onCancel (and never onSubmit)', () => {
    const onSubmit = jest.fn();
    const onCancel = jest.fn();
    const { result } = renderHook(() =>
      useProjectSetupWizard({ steps: makeSteps(), onSubmit, onCancel }),
    );

    act(() => result.current.cancel());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('reset returns navigation to the first step', () => {
    const { result } = renderHook(() =>
      useProjectSetupWizard({ steps: makeSteps(), onSubmit: jest.fn(), onCancel: jest.fn() }),
    );

    act(() => result.current.goNext());
    act(() => result.current.goNext());
    expect(result.current.currentStep?.id).toBe('teams');

    act(() => result.current.reset());
    expect(result.current.currentStep?.id).toBe('providers');
    expect(result.current.currentIndex).toBe(0);
  });
});
