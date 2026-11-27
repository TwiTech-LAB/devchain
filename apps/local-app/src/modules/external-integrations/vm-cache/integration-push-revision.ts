import { createHash } from 'node:crypto';
import type {
  DeliveredIntegrationConnection,
  IntegrationConnection,
} from '../../storage/models/domain.models';

/** The connections bound to a project: the ones home delivers to a VM. */
export function deliveredRows(
  rows: readonly IntegrationConnection[],
): DeliveredIntegrationConnection[] {
  return rows.flatMap(({ id, projectId, provider, generation }) =>
    projectId === null ? [] : [{ id, projectId, provider, generation }],
  );
}

/**
 * Home and VM compute the same revision for the same connection metadata, in any order.
 * It never covers credentials: a token replacement changes it through `generation`.
 */
export function hostIntegrationsRevision(
  connections: readonly DeliveredIntegrationConnection[],
): string {
  const rows = connections
    .map((c) => [c.id, c.projectId, c.provider, c.generation] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
