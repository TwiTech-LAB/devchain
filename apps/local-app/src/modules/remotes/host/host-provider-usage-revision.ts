import { createHash } from 'node:crypto';
import { ProviderUsageSettingsSchema, type ProviderUsageSettings } from '@devchain/shared';

/** Same values give the same revision on home and VM: parsing puts the keys in schema order. */
export function providerUsageSettingsRevision(settings: ProviderUsageSettings): string {
  return createHash('sha256')
    .update(JSON.stringify(ProviderUsageSettingsSchema.parse(settings)))
    .digest('hex');
}
