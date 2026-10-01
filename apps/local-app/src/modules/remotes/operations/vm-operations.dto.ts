import { z } from 'zod';
import { isProxmoxDnsName } from '../../../common/validation/proxmox-name';
import { ClaimChoiceFields } from './remote-operation.dto';

/** The claim and "Update VM" install peaks at about 1.7 GB, so smaller VMs fail. */
export const MIN_VM_MEMORY_MIB = 4096;

const ClaimInputs = {
  port: z.number().int().min(1024).max(65535).optional(),
  ...ClaimChoiceFields,
};

export const CreateVmSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    cores: z.number().int().min(1),
    memory: z
      .number()
      .int()
      .min(MIN_VM_MEMORY_MIB, {
        message: `Memory must be at least ${MIN_VM_MEMORY_MIB} MiB for the claim/update install.`,
      }),
    disk: z.number().int().min(1),
    ...ClaimInputs,
  })
  .strict();

export function createVmSchemaForNamePrefix(namePrefix: string) {
  return CreateVmSchema.superRefine(({ name }, context) => {
    if (!isProxmoxDnsName(`${namePrefix}${name}`)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['name'],
        message:
          'The full Proxmox VM name must use letters, digits, dots, or hyphens, with each dot-separated part starting and ending in a letter or digit.',
      });
    }
  });
}

export const ResetVmSchema = z
  .object({
    force: z.boolean().optional().default(false),
    ...ClaimInputs,
  })
  .strict();

export const DestroyVmSchema = z.object({ force: z.boolean().optional().default(false) }).strict();

export type CreateVmData = z.infer<typeof CreateVmSchema>;
export type ResetVmData = z.infer<typeof ResetVmSchema>;
export type DestroyVmData = z.infer<typeof DestroyVmSchema>;
