import { z } from 'zod';

export const HostWorktreesSchema = z.object({
  lanes: z.array(
    z.object({ name: z.string(), path: z.string(), branch: z.string(), dirty: z.boolean() }),
  ),
});
export const LaneAdmissionSchema = z.object({ frozen: z.boolean() }).strict();
