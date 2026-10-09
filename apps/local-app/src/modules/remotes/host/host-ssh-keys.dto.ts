import { z } from 'zod';
import { SshPublicKeysSchema } from '../../../common/validation/ssh-public-key';

export const HostSshKeysRequestSchema = z.object({ keys: SshPublicKeysSchema }).strict();
