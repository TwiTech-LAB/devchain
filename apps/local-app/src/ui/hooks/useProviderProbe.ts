import { useCallback, useState } from 'react';
import { getErrorMessage, useToastHelpers } from '@/ui/lib/toast-helpers';

/**
 * 1M-context probe state machine for the provider edit/create dialog.
 *
 * Extracted byte-identical from ProvidersPage's inline `handleProbe1mContext` +
 * the binPath-change rollback. Owns the probe status (`idle` / `probing` /
 * `supported` / `unsupported` / `error`), the threshold-field side effects of a
 * successful probe (sets 1M enabled + the 50%/95% defaults), and the rollback
 * fired when the user edits the binary path after a successful probe (1M is
 * only valid for the exact binary that was probed).
 *
 * Toast routing is preserved exactly: the API-result branches use the raw
 * `toast` helper (explicit variant on the unhappy paths), while a thrown
 * exception uses `showError`. This asymmetry is intentional — keep it.
 */

export type ProbeStatus = 'idle' | 'probing' | 'supported' | 'unsupported' | 'error';

/** The form-value slice the probe hook reads and writes. */
export interface ProviderProbeFormSlice {
  oneMillionContextEnabled: boolean;
  autoCompactThreshold1m: string;
  autoCompactThreshold: string;
}

export interface UseProviderProbeOptions<TValues extends ProviderProbeFormSlice> {
  /**
   * Functional updater for the page's form values. The hook merges probe-driven
   * patches (1M enable/disable, threshold defaults) via this callback, matching
   * the original inline `setFormData((prev) => ({ ...prev, ...patch }))`.
   */
  setValues: (updater: (prev: TValues) => TValues) => void;
}

export interface UseProviderProbeResult {
  probeStatus: ProbeStatus;
  setProbeStatus: (status: ProbeStatus) => void;
  /** Run the 1M-context probe for an existing provider and transition the state machine. */
  probe: (providerId: string) => Promise<void>;
  /**
   * Pure form-values patch to merge into a binPath change. Returns the 1M
   * rollback when the provider is Claude and 1M is currently enabled; empty
   * otherwise. The page merges this into its binPath `setFormData` so the
   * binPath write and the 1M rollback stay atomic (one state update).
   */
  binPathChangePatch: (
    prev: ProviderProbeFormSlice,
    isClaude: boolean,
  ) => Partial<ProviderProbeFormSlice>;
  /**
   * Probe-state side-effect of a binPath change: drop a stale 'supported'
   * status back to 'idle' so the checkbox re-probes before it can be trusted
   * again. Claude only; no-op for other providers.
   */
  onBinPathChange: (isClaude: boolean) => void;
  /** Reset to idle (used on dialog open/close and mutation success). */
  reset: () => void;
}

interface Probe1mResult {
  supported: boolean;
  status: string;
  capture?: string;
  detail?: string;
}

async function probeProvider1mContext(providerId: string): Promise<Probe1mResult> {
  const res = await fetch(`/api/providers/${providerId}/1m-context/probe`, { method: 'POST' });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Probe failed' }));
    throw new Error(error.message || 'Failed to probe 1M context support');
  }
  return res.json();
}

export function useProviderProbe<TValues extends ProviderProbeFormSlice>({
  setValues,
}: UseProviderProbeOptions<TValues>): UseProviderProbeResult {
  const [probeStatus, setProbeStatus] = useState<ProbeStatus>('idle');
  const { toast, showError } = useToastHelpers();

  const probe = useCallback(
    async (providerId: string) => {
      setProbeStatus('probing');
      try {
        const result = await probeProvider1mContext(providerId);
        if (result.supported) {
          setProbeStatus('supported');
          setValues((prev) => ({
            ...prev,
            oneMillionContextEnabled: true,
            autoCompactThreshold1m: '50',
            autoCompactThreshold: '95',
          }));
          toast({ title: '1M context supported', description: 'Threshold set to 50%.' });
          return;
        }

        if (result.status === 'unsupported') {
          setProbeStatus('unsupported');
          toast({
            title: '1M context not supported',
            description: result.detail ?? 'Binary does not support 1M.',
            variant: 'destructive',
          });
        } else {
          // launch_failure / timeout — retryable
          setProbeStatus('error');
          toast({
            title: 'Probe failed',
            description: result.detail ?? `Status: ${result.status}`,
            variant: 'destructive',
          });
        }
        setValues((prev) => ({ ...prev, oneMillionContextEnabled: false }));
      } catch (error) {
        setProbeStatus('error');
        setValues((prev) => ({ ...prev, oneMillionContextEnabled: false }));
        showError({
          title: 'Probe failed',
          description: getErrorMessage(error, 'Failed to probe 1M context.'),
        });
      }
    },
    [setValues, toast, showError],
  );

  const binPathChangePatch = useCallback(
    (prev: ProviderProbeFormSlice, isClaude: boolean): Partial<ProviderProbeFormSlice> => {
      if (isClaude && prev.oneMillionContextEnabled) {
        return {
          oneMillionContextEnabled: false,
          autoCompactThreshold1m: '',
          autoCompactThreshold: '95',
        };
      }
      return {};
    },
    [],
  );

  const onBinPathChange = useCallback(
    (isClaude: boolean) => {
      if (isClaude && probeStatus === 'supported') {
        setProbeStatus('idle');
      }
    },
    [probeStatus],
  );

  const reset = useCallback(() => {
    setProbeStatus('idle');
  }, []);

  return {
    probeStatus,
    setProbeStatus,
    probe,
    binPathChangePatch,
    onBinPathChange,
    reset,
  };
}
