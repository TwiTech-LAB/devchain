import { z } from 'zod';
import {
  SEMVER_PATTERN,
  VALIDATION_MESSAGES,
} from '../../../common/validation/template-validation';

/**
 * ManifestOverrideSchema - Validates manifest fields for the POST export endpoint.
 *
 * More lenient than ManifestSchema since users may provide partial overrides.
 * All fields are optional and will be merged with defaults during export.
 */
export const ManifestOverrideSchema = z
  .object({
    slug: z
      .string()
      .min(1, 'Slug cannot be empty')
      .max(100, 'Slug must be 100 characters or less')
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase alphanumeric with hyphens')
      .optional(),
    name: z
      .string()
      .min(1, 'Name cannot be empty')
      .max(200, 'Name must be 200 characters or less')
      .optional(),
    description: z
      .string()
      .max(2000, 'Description must be 2000 characters or less')
      .nullable()
      .optional(),
    category: z.enum(['development', 'planning', 'custom']).optional(),
    tags: z.array(z.string().min(1).max(50)).max(10, 'Maximum 10 tags allowed').optional(),
    authorName: z.string().max(200, 'Author name must be 200 characters or less').optional(),
    version: z.string().regex(SEMVER_PATTERN, VALIDATION_MESSAGES.INVALID_VERSION).optional(),
    changelog: z.string().max(5000, 'Changelog must be 5000 characters or less').optional(),
    minDevchainVersion: z
      .string()
      .regex(SEMVER_PATTERN, VALIDATION_MESSAGES.INVALID_VERSION)
      .optional(),
  })
  .strict();

/**
 * ExportWithOverridesSchema - Request body schema for POST /api/projects/:id/export
 */
export const ExportWithOverridesSchema = z.object({
  manifest: ManifestOverrideSchema.optional(),
});

/** TypeScript types inferred from schemas */
export type ManifestOverrideDto = z.infer<typeof ManifestOverrideSchema>;
export type ExportWithOverridesDto = z.infer<typeof ExportWithOverridesSchema>;
