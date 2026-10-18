import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { AppError } from '../errors/error-types';

export const VM_DESTROY_FENCE_PATH = '/etc/devchain-host/fence.json';
/** A VM instance's Linux user name, as the host bootstrap validates it. */
export const InstanceUserNameSchema = z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/);
export const VmDestroyFenceSchema = z
  .object({
    ownerUser: InstanceUserNameSchema,
    operationId: z.string().min(1).max(128),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type VmDestroyFence = z.infer<typeof VmDestroyFenceSchema>;

/** Must run inside the synchronous transaction admitting a hosted project. */
export function assertVmImportAllowed(): void {
  let raw: string;
  try {
    raw = readFileSync(VM_DESTROY_FENCE_PATH, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new AppError('Cannot read the VM destroy fence.', 'VM_FENCE_UNREADABLE', 503);
  }
  let fence: VmDestroyFence;
  try {
    fence = VmDestroyFenceSchema.parse(JSON.parse(raw));
  } catch {
    throw new AppError('The VM destroy fence is invalid.', 'VM_FENCE_INVALID', 503);
  }
  if (Date.parse(fence.expiresAt) <= Date.now()) return;
  throw new AppError(
    `This VM is being reset or destroyed by ${fence.ownerUser}. Try again after they finish.`,
    'VM_DESTROY_PENDING',
    409,
    { ownerUser: fence.ownerUser, operationId: fence.operationId },
  );
}
