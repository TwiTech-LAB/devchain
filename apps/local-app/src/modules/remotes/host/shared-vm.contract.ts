import { z } from 'zod';
import {
  InstanceUserNameSchema,
  VmDestroyFenceSchema,
} from '../../../common/config/vm-destroy-fence';
import { HostProjectIdSchema } from './host.dto';
export { SharedVmRosterSchema } from '../dtos/shared-vm.dto';
export type { SharedVmRoster } from '../dtos/shared-vm.dto';

export const SharedVmActionSchema = z.enum(['reset', 'destroy', 'forced']);
export const SharedVmNotifySchema = z
  .object({
    action: SharedVmActionSchema,
    message: z.string().max(2000).optional(),
  })
  .strict();
export const SharedVmInboxSchema = SharedVmNotifySchema.extend({
  fromUser: InstanceUserNameSchema,
  at: z.string().datetime({ offset: true }),
}).strict();
export const SharedVmNoticeSchema = SharedVmInboxSchema.extend({ id: z.string().uuid() });
export const SharedVmNoticesSchema = z.object({ notices: z.array(SharedVmNoticeSchema) });
export const SharedVmDismissSchema = z.object({ id: z.string().uuid() }).strict();
export const SharedVmAbandonSchema = z.object({ projectId: HostProjectIdSchema }).strict();
export const SharedVmCountSchema = z
  .object({
    connectedCount: z.number().int().nonnegative(),
    connectedProjectIds: z.array(z.string()),
  })
  .refine(
    ({ connectedCount, connectedProjectIds }) =>
      connectedCount === connectedProjectIds.length &&
      new Set(connectedProjectIds).size === connectedCount,
  );
export const SharedVmNotifyResultSchema = z.object({
  results: z.array(
    z.object({
      user: z.string(),
      delivered: z.boolean(),
    }),
  ),
});
export const SharedVmFenceRequestSchema = z
  .object({
    mode: z.enum(['set', 'clear']),
    operationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  })
  .strict();
export const SharedVmFenceResultSchema = z.object({ fence: VmDestroyFenceSchema.nullable() });
export type SharedVmNotice = z.infer<typeof SharedVmNoticeSchema>;
export type SharedVmInbox = z.infer<typeof SharedVmInboxSchema>;
export type SharedVmNotify = z.infer<typeof SharedVmNotifySchema>;
export type SharedVmNotifyResult = z.infer<typeof SharedVmNotifyResultSchema>;
