import { createHash } from 'node:crypto';
import { ReplicaProviderSettingsRowSchema } from '@devchain/shared';
import type { ReplicaProviderSettingsRow } from '../../storage/interfaces/storage.interface';

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The same rows give the same revision on home and the VM whatever their order:
 * providers, env keys, scope keys and scope project ids are sorted first. The
 * row schema puts the fields in schema order, so a field added to the row is
 * part of the revision.
 */
export function providerSettingsRevision(providers: readonly ReplicaProviderSettingsRow[]): string {
  const canonical = [...providers]
    .sort((a, b) => compare(a.providerName, b.providerName))
    .map((row) => ({
      ...ReplicaProviderSettingsRowSchema.parse(row),
      env: row.env === null ? null : Object.entries(row.env).sort(([a], [b]) => compare(a, b)),
      envScopes: Object.entries(row.envScopes)
        .sort(([a], [b]) => compare(a, b))
        .map(([key, projectIds]) => [key, [...projectIds].sort(compare)]),
    }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
