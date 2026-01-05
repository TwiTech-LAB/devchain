import { z } from 'zod';
import { isValidSemVer } from '../utils/semver.js';

/**
 * Semver string schema with validation
 */
const semverString = z
  .string()
  .refine((v) => isValidSemVer(v), {
    message: 'Must be a valid semantic version (e.g., "1.0.0", "0.4.0-beta.1")',
  });

/**
 * ManifestSchema - Template metadata embedded in export files.
 * Used for display/UX purposes. Registry DB remains authoritative for versioning.
 *
 * Fields:
 * - slug: Unique identifier (optional, inferred from filename/context)
 * - name: Display name (required)
 * - description: Template description
 * - category: Template category (development, planning, custom)
 * - tags: Searchable tags (max 10)
 * - authorName: Template author
 * - minDevchainVersion: Minimum compatible devchain version
 * - isOfficial: Whether this is an official Devchain template
 * - version: Semantic version (optional, may be set by registry)
 * - publishedAt: ISO timestamp of publish (set by registry)
 * - changelog: Version changelog (for registry publishing)
 * - gitCommit: Git commit hash (for traceability)
 */
export const ManifestSchema = z
  .object({
    slug: z.string().min(1).optional(),
    name: z.string().min(1),
    description: z.string().nullable().optional(),
    category: z.enum(['development', 'planning', 'custom']).optional(),
    tags: z.array(z.string()).max(10).optional(),
    authorName: z.string().optional(),
    minDevchainVersion: semverString.optional(),
    isOfficial: z.boolean().optional(),
    version: semverString.optional(),
    publishedAt: z.string().optional(),
    changelog: z.string().optional(),
    gitCommit: z.string().optional(),
  })
  .strict();

/** Inferred TypeScript type for template manifest metadata */
export type ManifestData = z.infer<typeof ManifestSchema>;

/**
 * ExportSchema - The canonical schema for template/project export format.
 * Used by both local-app and template-registry for consistent data interchange.
 */
export const ExportSchema = z
  .object({
    version: z.number().optional().default(1),
    exportedAt: z.string().optional(),
    prompts: z
      .array(
        z.object({
          id: z.string().uuid().optional(),
          title: z.string().min(1),
          content: z.string().default(''),
          version: z.number().optional(),
          tags: z.array(z.string()).optional().default([]),
        }),
      )
      .optional()
      .default([]),
    profiles: z
      .array(
        z.object({
          id: z.string().uuid().optional(),
          name: z.string().min(1),
          provider: z.object({ id: z.string().optional(), name: z.string().min(1) }),
          familySlug: z.string().nullable().optional(),
          options: z.unknown().nullable().optional(),
          instructions: z.string().nullable().optional(),
          temperature: z.number().nullable().optional(),
          maxTokens: z.number().int().nullable().optional(),
        }),
      )
      .optional()
      .default([]),
    agents: z
      .array(
        z.object({
          id: z.string().uuid().optional(),
          name: z.string().min(1),
          profileId: z.string().uuid().optional(),
          description: z.string().nullable().optional(),
        }),
      )
      .optional()
      .default([]),
    statuses: z
      .array(
        z.object({
          id: z.string().uuid().optional(),
          label: z.string().min(1),
          color: z.string().min(1),
          position: z.number().int(),
          mcpHidden: z.boolean().optional().default(false),
        }),
      )
      .optional()
      .default([]),
    initialPrompt: z
      .object({ promptId: z.string().uuid().optional(), title: z.string().optional() })
      .nullable()
      .optional(),
    // Project-specific settings (uses labels/titles for portability, not IDs)
    projectSettings: z
      .object({
        initialPromptTitle: z.string().optional(),
        autoCleanStatusLabels: z.array(z.string()).optional(),
        epicAssignedTemplate: z.string().optional(),
        // Message pool settings for this project
        messagePoolSettings: z
          .object({
            enabled: z.boolean().optional(),
            delayMs: z.number().optional(),
            maxWaitMs: z.number().optional(),
            maxMessages: z.number().optional(),
            separator: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
    // Terminal watchers (uses name-based scope references for portability)
    watchers: z
      .array(
        z.object({
          id: z.string().uuid().optional(),
          name: z.string().min(1),
          description: z.string().nullable().optional(),
          enabled: z.boolean(),
          scope: z.enum(['all', 'agent', 'profile', 'provider']),
          scopeFilterName: z.string().nullable().optional(), // agent/profile/provider name
          pollIntervalMs: z.number().int(),
          viewportLines: z.number().int(),
          condition: z.object({
            type: z.enum(['contains', 'regex', 'not_contains']),
            pattern: z.string(),
            flags: z.string().optional(),
          }),
          cooldownMs: z.number().int(),
          cooldownMode: z.enum(['time', 'until_clear']),
          eventName: z.string(),
        }),
      )
      .optional()
      .default([]),
    // Automation subscribers
    subscribers: z
      .array(
        z.object({
          id: z.string().uuid().optional(),
          name: z.string().min(1),
          description: z.string().nullable().optional(),
          enabled: z.boolean(),
          eventName: z.string(),
          eventFilter: z
            .object({
              field: z.string(),
              operator: z.enum(['equals', 'contains', 'regex']),
              value: z.string(),
            })
            .nullable()
            .optional(),
          actionType: z.string(),
          actionInputs: z.record(
            z.string(),
            z.object({
              source: z.enum(['event_field', 'custom']),
              eventField: z.string().optional(),
              customValue: z.string().optional(),
            }),
          ),
          delayMs: z.number().int(),
          cooldownMs: z.number().int(),
          retryOnError: z.boolean(),
          // Grouping & ordering
          groupName: z.string().nullable().optional(),
          position: z.number().int().optional().default(0),
          priority: z.number().int().optional().default(0),
        }),
      )
      .optional()
      .default([]),
    // Template manifest metadata (optional, for display/UX purposes)
    _manifest: ManifestSchema.optional(),
  })
  .strict();

/** Inferred TypeScript type from the ExportSchema */
export type ExportData = z.infer<typeof ExportSchema>;

/** Input type for ExportSchema (before defaults are applied) */
export type ExportDataInput = z.input<typeof ExportSchema>;
