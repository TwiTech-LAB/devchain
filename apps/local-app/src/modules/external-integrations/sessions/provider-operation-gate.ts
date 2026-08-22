/**
 * Single shared gate for provider mutations and connection replacement. One
 * singleton instance is injected into both the edit-session service and the
 * connections service, so a final preflight + one vendor mutation can never
 * interleave with a credential swap or disconnect for the same provider.
 */
import { BusyError } from '../../../common/errors/error-types';

export type ProviderOperationGateKey = string;

export const PROVIDER_GATE_BUSY_REASON = 'operation_in_progress';

interface GateEntry {
  promise: Promise<void>;
}

export class ProviderOperationGate {
  private readonly held = new Map<ProviderOperationGateKey, GateEntry>();

  /**
   * Runs `operation` exclusively for `key`. A second caller while the gate is
   * held receives BusyError immediately — mutation safety never queues
   * behind an unknown-duration vendor call.
   */
  async run<T>(key: ProviderOperationGateKey, operation: () => Promise<T>): Promise<T> {
    if (this.held.has(key)) {
      throw new BusyError('A provider operation is already in progress.', {
        reason: PROVIDER_GATE_BUSY_REASON,
        provider: key,
      });
    }
    let release: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.held.set(key, { promise });
    try {
      return await operation();
    } finally {
      this.held.delete(key);
      release();
    }
  }

  isHeld(key: ProviderOperationGateKey): boolean {
    return this.held.has(key);
  }
}
