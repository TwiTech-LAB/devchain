import { z } from 'zod';

const LOCAL_SOURCE_NAME_PATTERN = /^[a-z0-9-]+$/;

export const LocalSourceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((value) => value.toLowerCase())
  .refine((value) => LOCAL_SOURCE_NAME_PATTERN.test(value), {
    message: 'Source name must contain only lowercase letters, numbers, and hyphens.',
  });

export const LocalSourceFolderPathSchema = z.string().trim().min(1).max(4096);

export const CreateLocalSourceSchema = z.object({
  name: LocalSourceNameSchema,
  folderPath: LocalSourceFolderPathSchema,
});

export const LocalSourceResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  folderPath: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const LocalSourceDeleteParamsSchema = z.object({
  id: z.string().uuid(),
});

export type CreateLocalSourceDto = z.infer<typeof CreateLocalSourceSchema>;
export type LocalSourceResponseDto = z.infer<typeof LocalSourceResponseSchema>;
export type LocalSourceDeleteParamsDto = z.infer<typeof LocalSourceDeleteParamsSchema>;
