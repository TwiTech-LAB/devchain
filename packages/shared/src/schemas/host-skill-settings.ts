import { z } from 'zod';

export const HostSkillSourceNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/);
const repoPart = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9._-]+$/);
export const HostSkillContentHashSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9-]+$/);
export const HostSkillSettingsSchema = z
  .object({
    revision: z.string().min(1).max(128),
    communitySources: z.array(
      z
        .object({
          name: HostSkillSourceNameSchema,
          repoOwner: repoPart,
          repoName: repoPart,
          branch: z.string().trim().min(1).max(200),
        })
        .strict(),
    ),
    localSources: z.array(
      z
        .object({
          name: HostSkillSourceNameSchema,
          folderPath: z
            .string()
            .trim()
            .min(1)
            .max(4096)
            .refine((path) => path.startsWith('/'), 'Absolute folder path required'),
          contentHash: HostSkillContentHashSchema,
        })
        .strict(),
    ),
    sourcesEnabled: z.record(HostSkillSourceNameSchema, z.boolean()),
    projectIds: z.array(z.string().min(1)),
    projectSourceSwitches: z.array(
      z
        .object({
          projectId: z.string().min(1),
          sourceName: HostSkillSourceNameSchema,
          enabled: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((body, ctx) => {
    const names = [...body.communitySources, ...body.localSources].map((source) => source.name);
    if (new Set(names).size !== names.length)
      ctx.addIssue({ code: 'custom', message: 'Source names must be unique' });
    if (names.some((name) => !Object.prototype.hasOwnProperty.call(body.sourcesEnabled, name)))
      ctx.addIssue({ code: 'custom', message: 'Every source needs an effective switch' });
    if (body.projectSourceSwitches.some((row) => !body.projectIds.includes(row.projectId)))
      ctx.addIssue({ code: 'custom', message: 'Source switches must belong to listed projects' });
  });
export const HostSkillSettingsStatusSchema = z.object({
  appliedRevision: z.string().nullable(),
  pendingRevision: z.string().nullable(),
  skipped: z.array(
    z.object({ name: z.string(), kind: z.enum(['community', 'local']), reason: z.string() }),
  ),
  needsContent: z.array(z.object({ name: z.string(), contentHash: z.string() })),
});
export type HostSkillSettings = z.infer<typeof HostSkillSettingsSchema>;
export type HostSkillSettingsStatus = z.infer<typeof HostSkillSettingsStatusSchema>;
