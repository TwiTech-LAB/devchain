import { z } from 'zod';

export const VmGitGuardRequestSchema = z
  .object({
    homeName: z.string().trim().min(1).max(255),
    reason: z.enum(['disconnect', 'cancelled-connect', 'pc-git']),
  })
  .strict();

export type VmGitGuardRequest = z.infer<typeof VmGitGuardRequestSchema>;

export const GitGuardInstallResultSchema = z.object({ warning: z.string().nullable() });
export const GitGuardRemoveRequestSchema = z
  .object({ refreshIndex: z.boolean().default(false) })
  .strict();
export const GitGuardRemoveResultSchema = z.object({
  removed: z.boolean(),
  indexRefreshed: z.boolean().nullable(),
  warning: z.string().nullable(),
});
export type GitGuardRemoveResult = z.infer<typeof GitGuardRemoveResultSchema>;
