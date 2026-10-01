import { createHash } from 'node:crypto';
import { HostProviderCliPolicySchema, type HostProviderCliPolicy } from '@devchain/shared';

export function providerCliPolicyRevision(policy: HostProviderCliPolicy): string {
  return createHash('sha256')
    .update(JSON.stringify(HostProviderCliPolicySchema.parse(policy)))
    .digest('hex');
}
