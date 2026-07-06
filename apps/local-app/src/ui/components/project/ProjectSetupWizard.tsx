import { Fragment, type ReactNode } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { cn } from '@/ui/lib/utils';
import type { ProjectSetupWizardController } from '@/ui/hooks/useProjectSetupWizard';

interface ProjectSetupWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Step machine from `useProjectSetupWizard`, wired to the active flow's steps. */
  controller: ProjectSetupWizardController;
  title?: string;
  description?: string;
  /** Label for the final action button on the last step (e.g. "Create" / "Replace Project"). */
  submitLabel?: string;
  /** Disables the final action while the create/import mutation is in flight. */
  isSubmitting?: boolean;
  /** Show the loading slot instead of step content (e.g. while the setup-preview is fetching). */
  isLoading?: boolean;
  loadingContent?: ReactNode;
  /** Show the error slot instead of step content (e.g. setup-preview failed). */
  errorContent?: ReactNode;
}

/**
 * Flow-agnostic wizard shell: hosts a step-indicator header, the active step's body, and a
 * Back/Next(or Create)/Cancel footer driven entirely by the injected controller. It renders step
 * CONTENT via `currentStep.render()` (supplied by the flow — create Steps 1-3 land in Tasks 5-7)
 * and never fires a mutation itself: the final action calls the controller's `submit`, and Cancel
 * calls `cancel`, so closing at any step creates nothing.
 */
export function ProjectSetupWizard({
  open,
  onOpenChange,
  controller,
  title = 'Create Project',
  description,
  submitLabel = 'Create',
  isSubmitting = false,
  isLoading = false,
  loadingContent,
  errorContent,
}: ProjectSetupWizardProps) {
  const {
    visibleSteps,
    currentStep,
    currentIndex,
    isFirstStep,
    isLastStep,
    canProceed,
    goNext,
    goBack,
    submit,
    cancel,
  } = controller;

  const showSteps = !isLoading && !errorContent;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {(currentStep?.description ?? description) && (
            <DialogDescription>{currentStep?.description ?? description}</DialogDescription>
          )}
        </DialogHeader>

        {/* Step indicator: Providers → Agents → Teams */}
        {showSteps && visibleSteps.length > 0 && (
          <nav aria-label="Setup steps" className="flex items-center gap-1 text-sm">
            {visibleSteps.map((step, index) => {
              const isActive = index === currentIndex;
              const isComplete = index < currentIndex;
              return (
                <Fragment key={step.id}>
                  {index > 0 && (
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <span
                    aria-current={isActive ? 'step' : undefined}
                    className={cn(
                      'flex items-center gap-1.5 rounded-md px-2 py-1',
                      isActive && 'bg-muted font-medium text-foreground',
                      !isActive && isComplete && 'text-foreground',
                      !isActive && !isComplete && 'text-muted-foreground',
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-5 w-5 items-center justify-center rounded-full border text-xs',
                        isActive && 'border-primary bg-primary text-primary-foreground',
                        !isActive && isComplete && 'border-primary/50 text-foreground',
                        !isActive && !isComplete && 'border-muted-foreground/40',
                      )}
                    >
                      {index + 1}
                    </span>
                    {step.title}
                  </span>
                </Fragment>
              );
            })}
          </nav>
        )}

        {/* Body: capped + scrollable so long step content (agent lists, team panels)
            never pushes the dialog past the viewport — header/stepper/footer stay pinned. */}
        <div className="min-h-[8rem] max-h-[60vh] overflow-y-auto py-2 pr-1">
          {isLoading
            ? (loadingContent ?? (
                <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading template…
                </div>
              ))
            : errorContent
              ? errorContent
              : currentStep?.render()}
        </div>

        <DialogFooter className="sm:justify-between">
          <Button type="button" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={goBack}
              disabled={isFirstStep || isSubmitting}
            >
              Back
            </Button>
            {isLastStep ? (
              <Button
                type="button"
                onClick={submit}
                disabled={!showSteps || !canProceed || isSubmitting}
              >
                {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {submitLabel}
              </Button>
            ) : (
              <Button type="button" onClick={goNext} disabled={!showSteps || !canProceed}>
                Next
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
