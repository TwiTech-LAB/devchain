import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { getEnvConfig } from '../../../common/config/env.config';
import { VmUidConflictSchema } from '../../remotes/vm-user-identity';

const HostUserIdentitySchema = z.object({
  requestedUid: z.number().int().optional(),
  requestedGid: z.number().int().optional(),
  primaryGroup: z.string().optional(),
  uidConflict: VmUidConflictSchema.optional(),
});

export function readHostUserIdentity(
  file = join(getEnvConfig().DEVCHAIN_HOST_ETC_DIR, 'claim.json'),
): z.infer<typeof HostUserIdentitySchema> {
  try {
    return HostUserIdentitySchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return {};
  }
}
