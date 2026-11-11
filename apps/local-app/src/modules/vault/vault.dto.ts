import type { HostVaultStatus } from '@devchain/shared';
import { z } from 'zod';
import type { RuntimeDirectoryStatus } from '../runtime-directory/runtime-directory.service';
import type { VaultStatus } from './vault-key.service';
import type { VaultStoreMigrationStatus } from './vault-store-migration.service';
import { VAULT_FILE_MAX_BYTES } from './vault-entry-rules';

export const VaultSetupSchema = z.object({ mode: z.enum(['file', 'recovery']) }).strict();

export const VaultUnlockSchema = z.object({ recoveryCode: z.string().min(1).max(256) }).strict();

/** `recoveryCode` is present only until the user confirms it was saved. */
export type VaultStatusDto = VaultStatus & { recoveryCode?: string };

/**
 * The status route also reports where launch scripts and Vault files live, how far the
 * move of existing stores to the Vault key got and, on a claimed VM, the state of the
 * cache of values that home pushed.
 */
export type VaultStatusResponseDto = VaultStatusDto & {
  runtime: RuntimeDirectoryStatus;
  storeMigration: VaultStoreMigrationStatus;
  vmCache?: Pick<HostVaultStatus, 'cacheReady' | 'cacheUnavailable'>;
};

const EntryName = z.string().min(1).max(255);
const EntryDescription = z.string().trim().min(1).max(1000);
// The kind's exact limit is checked in `vault-entry-rules.ts`; this only caps the body.
const EntryValue = z.string().min(1).max(VAULT_FILE_MAX_BYTES);

const ProjectId = z.string().min(1);

/** `?projectId=` of the entry and grant lists. */
export const VaultProjectQuerySchema = z.object({ projectId: ProjectId.optional() });
// Keep in step with the template schema's rule (`@devchain/shared` export-schema.ts). The
// schema cannot be imported: shared's zod is another module instance, and its ZodError is
// not `instanceof` this app's, so route validation failures would answer 500, not 400.
const FamilySlugs = z.array(z.string().trim().min(1).max(255)).min(1).max(100);

const EntryProject = z.discriminatedUnion('mode', [
  z.object({ projectId: ProjectId, mode: z.literal('all') }).strict(),
  z
    .object({ projectId: ProjectId, mode: z.literal('families'), familySlugs: FamilySlugs })
    .strict(),
]);

function unique<T>(key: (item: T) => string, label: string) {
  return (items: T[], ctx: z.RefinementCtx) => {
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (seen.has(key(item))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `Give each ${label} once.`,
        });
      }
      seen.add(key(item));
    }
  };
}

const EntryProjects = z
  .array(EntryProject)
  .max(500)
  .superRefine(unique((item) => item.projectId, 'project'));

export const VaultEntryCreateSchema = z
  .object({
    projects: EntryProjects,
    name: EntryName,
    kind: z.enum(['secret', 'file']),
    description: EntryDescription,
    value: EntryValue,
    approvalRequired: z.boolean().optional(),
  })
  .strict();

export const VaultEntryUpdateSchema = z
  .object({
    name: EntryName.optional(),
    description: EntryDescription.optional(),
    projects: EntryProjects.optional(),
    approvalRequired: z.boolean().optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.name !== undefined ||
      body.description !== undefined ||
      body.projects !== undefined ||
      body.approvalRequired !== undefined,
    { message: 'Give a name, a description, projects or approvalRequired.' },
  );

export const VaultEntryValueSchema = z.object({ value: EntryValue }).strict();

const GrantEntry = { entryId: z.string().min(1) };

/** A project's Vault access: `none` turns the Vault off, `all` admits every agent. */
const ProjectAccess = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all') }).strict(),
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('families'), familySlugs: FamilySlugs }).strict(),
]);

export const VaultProjectGrantsSchema = z
  .object({
    entries: z
      .array(
        z.discriminatedUnion('mode', [
          z.object({ ...GrantEntry, mode: z.literal('all') }).strict(),
          z.object({ ...GrantEntry, mode: z.literal('none') }).strict(),
          z
            .object({ ...GrantEntry, mode: z.literal('families'), familySlugs: FamilySlugs })
            .strict(),
        ]),
      )
      .max(500)
      .superRefine(unique((item) => item.entryId, 'entry')),
    access: ProjectAccess.optional(),
  })
  .strict();

/**
 * Body of the resolve route. `names` limits the result to these entries; each must be
 * granted. Parse errors never echo the body: it names the caller's secrets.
 */
export const VaultResolveSchema = z
  .object({
    sessionId: z.string().max(64),
    names: z
      .array(
        z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
          .max(255),
      )
      .min(1)
      .max(200)
      .optional(),
  })
  .strict();
