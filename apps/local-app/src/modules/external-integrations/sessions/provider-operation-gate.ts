/**
 * Single shared gate for provider mutations and connection replacement. One
 * singleton instance is injected into both the edit-session service and the
 * connections service, so a final preflight + one vendor mutation can never
 * interleave with a credential swap or disconnect for the same project connection.
 */
import { BusyError } from '../../../common/errors/error-types';
import type { IntegrationProvider } from '../../storage/models/domain.models';

export type ProviderOperationGateKey = string;
export interface ProjectProviderOperationScope {
  projectId: string;
  provider: IntegrationProvider;
}
export interface ExactConnectionOperationScope {
  connectionId: string;
  provider: IntegrationProvider;
}

export type ProviderOperationScope =
  | IntegrationProvider
  | ProjectProviderOperationScope
  | ExactConnectionOperationScope;

export function projectProviderOperationGateKey(
  projectId: string,
  provider: IntegrationProvider,
): ProviderOperationGateKey {
  return `${projectId}:${provider}`;
}

export function exactConnectionOperationGateKey(connectionId: string): ProviderOperationGateKey {
  return `connection:${connectionId}`;
}

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
  async run<T>(scope: ProviderOperationScope, operation: () => Promise<T>): Promise<T> {
    const key = this.toKey(scope);
    if (this.held.has(key)) {
      const details: {
        reason: string;
        provider: IntegrationProvider;
        projectId?: string;
        connectionId?: string;
      } = {
        reason: PROVIDER_GATE_BUSY_REASON,
        provider: typeof scope === 'string' ? scope : scope.provider,
      };
      if (typeof scope !== 'string') {
        if ('projectId' in scope) {
          details.projectId = scope.projectId;
        } else {
          details.connectionId = scope.connectionId;
        }
      }
      throw new BusyError('A provider operation is already in progress.', details);
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

  isHeld(scope: ProviderOperationScope): boolean {
    return this.held.has(this.toKey(scope));
  }

  private toKey(scope: ProviderOperationScope): ProviderOperationGateKey {
    if (typeof scope === 'string') {
      return scope;
    }
    if ('projectId' in scope) {
      return projectProviderOperationGateKey(scope.projectId, scope.provider);
    }
    return exactConnectionOperationGateKey(scope.connectionId);
  }
}
