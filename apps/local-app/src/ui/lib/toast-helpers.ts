import { useCallback } from 'react';
import { useToast } from '@/ui/hooks/use-toast';

/**
 * Safely extract a human-readable message from a thrown value, falling back to
 * `fallback` when the value is not an `Error` instance. Replaces the repeated
 * `error instanceof Error ? error.message : 'fallback'` ternary at mutation
 * error sites — copy (the fallback string) is supplied by each caller, so this
 * only standardizes extraction, not wording.
 */
export function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

type ToastCopy = {
  title: string;
  description: string;
};

/**
 * Toast toolbox bound to the shared toast store via `useToast`. Provides named
 * presets for the two toast shapes repeated across CRUD pages (plain success,
 * destructive error) alongside the raw `toast` primitive. Presets are kept
 * referentially stable (they close over the stable module-level `toast`) so
 * they are safe to use in `useCallback` dependency arrays. Copy (title /
 * description) is always caller-supplied — this standardizes plumbing, not
 * wording.
 */
export function useToastHelpers() {
  const { toast } = useToast();
  const showSuccess = useCallback(
    (copy: ToastCopy) => toast({ title: copy.title, description: copy.description }),
    [toast],
  );
  const showError = useCallback(
    (copy: ToastCopy) =>
      toast({ title: copy.title, description: copy.description, variant: 'destructive' }),
    [toast],
  );
  return { toast, showSuccess, showError };
}
