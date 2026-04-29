import { z } from 'zod';

export const FolderPurposeSchema = z.enum([
  'source',
  'test-source',
  'generated',
  'resources',
  'excluded',
]);

export const ScopeEntryOriginSchema = z.enum(['default', 'user']);

export const FolderScopeEntrySchema = z
  .object({
    folder: z.string().min(1),
    purpose: FolderPurposeSchema,
    reason: z.string(),
    origin: ScopeEntryOriginSchema,
  })
  .strict();

export const ScopeConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.array(FolderScopeEntrySchema),
  })
  .strict();
