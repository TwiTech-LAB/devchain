import { z } from 'zod';

/**
 * Home → claimed VM Vault push. Home sends only the entries that a grant gives to one
 * of the VM's projects, with only those grants, plus each entry's value. The VM keeps
 * the metadata in its DB and the values in a tmpfs file only.
 */
export const HOST_VAULT_CONTENT_TYPE = 'application/vnd.devchain.host-vault+json';
/** Above the app-wide 1 MiB JSON limit: one `file` value alone can be 256 KiB. */
export const HOST_VAULT_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
export const HOST_VAULT_MAX_ENTRIES = 1000;
/** The largest decoded value: a `file` entry (256 KiB); a `secret` is smaller. */
export const HOST_VAULT_VALUE_MAX_BYTES = 256 * 1024;

const Id = z.string().min(1).max(128);
const Base64 = z
  .string()
  .max(Math.ceil(HOST_VAULT_VALUE_MAX_BYTES / 3) * 4)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/);

export const HostVaultEntrySchema = z
  .object({
    id: Id,
    /** Null for a global entry. */
    projectId: Id.nullable(),
    name: z
      .string()
      .max(255)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    kind: z.enum(['secret', 'file']),
    description: z.string().min(1).max(1000),
    revision: z.number().int().positive(),
    /** A session needs the user's approval before it receives the value. */
    approvalRequired: z.boolean(),
  })
  .strict();

const NamedFamilySlug = z
  .string()
  .min(1)
  .max(255)
  .refine((slug) => slug === slug.trim().toLowerCase(), 'Lowercase, trimmed slug required');
/** Null covers every agent of the project; otherwise a lowercase family slug. */
const FamilySlug = NamedFamilySlug.nullable();

export const HostVaultGrantSchema = z
  .object({ entryId: Id, projectId: Id, familySlug: FamilySlug })
  .strict();

/** One Vault access row of a pushed project; a project with no row has the Vault off. */
export const HostVaultAccessSchema = z.object({ projectId: Id, familySlug: FamilySlug }).strict();

/** "Never ask again" for one family of a pushed project; always names a family. */
export const HostVaultApprovalSchema = z
  .object({ entryId: Id, projectId: Id, familySlug: NamedFamilySlug })
  .strict();

export const HostVaultValueSchema = z
  .object({ entryId: Id, revision: z.number().int().positive(), valueBase64: Base64 })
  .strict();

/**
 * Grants and approvals follow the same rules: each row names a listed entry, a project
 * entry gets rows only in its own project, and rows are unique.
 */
function checkEntryRows(
  ctx: z.RefinementCtx,
  entries: ReadonlyMap<string, { projectId: string | null }>,
  rows: ReadonlyArray<{ entryId: string; projectId: string; familySlug: string | null }>,
  messages: { missing: string; otherProject: string; duplicate: string },
): void {
  const keys = new Set<string>();
  for (const row of rows) {
    const entry = entries.get(row.entryId);
    if (!entry) {
      ctx.addIssue({ code: 'custom', message: messages.missing });
    } else if (entry.projectId !== null && entry.projectId !== row.projectId) {
      ctx.addIssue({ code: 'custom', message: messages.otherProject });
    }
    keys.add(`${row.entryId}\u0000${row.projectId}\u0000${row.familySlug ?? ''}`);
  }
  if (keys.size !== rows.length) ctx.addIssue({ code: 'custom', message: messages.duplicate });
}

export const HostVaultPushSchema = z
  .object({
    /** `vaultSnapshotRevision` of `entries`, `grants`, `access` and `approvals`; never covers values. */
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    entries: z.array(HostVaultEntrySchema).max(HOST_VAULT_MAX_ENTRIES),
    grants: z.array(HostVaultGrantSchema),
    access: z.array(HostVaultAccessSchema),
    approvals: z.array(HostVaultApprovalSchema),
    values: z.array(HostVaultValueSchema).max(HOST_VAULT_MAX_ENTRIES),
  })
  .strict()
  .superRefine((body, ctx) => {
    const entries = new Map(body.entries.map((entry) => [entry.id, entry]));
    if (entries.size !== body.entries.length)
      ctx.addIssue({ code: 'custom', message: 'Entry ids must be unique' });
    const owners = body.entries.map((entry) => `${entry.projectId ?? ''}\u0000${entry.name}`);
    if (new Set(owners).size !== owners.length)
      ctx.addIssue({ code: 'custom', message: 'Entry names must be unique for each owner' });

    checkEntryRows(ctx, entries, body.grants, {
      missing: 'Every grant must name a listed entry',
      otherProject: 'A project entry is granted only in its project',
      duplicate: 'Grants must be unique',
    });

    const accessKeys = new Set(
      body.access.map((row) => `${row.projectId}\u0000${row.familySlug ?? ''}`),
    );
    if (accessKeys.size !== body.access.length)
      ctx.addIssue({ code: 'custom', message: 'Access rows must be unique' });

    checkEntryRows(ctx, entries, body.approvals, {
      missing: 'Every approval must name a listed entry',
      otherProject: 'A project entry is approved only in its project',
      duplicate: 'Approvals must be unique',
    });

    const valued = new Set<string>();
    for (const value of body.values) {
      if (entries.get(value.entryId)?.revision !== value.revision || valued.has(value.entryId))
        ctx.addIssue({
          code: 'custom',
          message: 'Each value must match one listed entry revision',
        });
      valued.add(value.entryId);
    }
    if (valued.size !== entries.size)
      ctx.addIssue({ code: 'custom', message: 'Every entry needs its value' });
  });

/** Why a VM cannot hold Vault values; home stops pushing until an Update VM fixes it. */
export const HostVaultCacheUnavailableSchema = z.enum([
  'runtime_directory_missing',
  'runtime_directory_not_tmpfs',
]);

/** Reported in the VM runtime payload. Never carries a value. */
export const HostVaultStatusSchema = z.object({
  /** Revision of the metadata snapshot the VM holds. */
  appliedRevision: z.string(),
  /** True when the cache holds every snapshot entry at its revision. */
  cacheReady: z.boolean(),
  cacheUnavailable: HostVaultCacheUnavailableSchema.nullable(),
});

/**
 * A session-only answer: the VM keeps the value in memory for the asking session.
 * Carries a value, so the body is never logged or echoed in an error.
 */
const HostVaultSessionValueSchema = z
  .object({
    value: z
      .string()
      .min(1)
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= HOST_VAULT_VALUE_MAX_BYTES,
        'Value too large',
      ),
  })
  .strict();

/**
 * Home's answer to a VM request. A stored or granted answer has no `sessionValue`: the
 * VM reads the entry from its pushed Vault cache. `approved` answers a `use` request
 * only, and carries no value.
 */
/** How long an approved `use` lasts: this session, one delivery, or the agent's family. */
export const HostVaultUseDecisionSchema = z.enum(['session', 'once', 'family']);

export const HostVaultRequestResolveSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('fulfilled'),
      sessionValue: HostVaultSessionValueSchema.optional(),
    })
    .strict(),
  z.object({ status: z.literal('approved'), decision: HostVaultUseDecisionSchema }).strict(),
  z.object({ status: z.literal('denied'), reason: z.string().max(200).optional() }).strict(),
]);

export type HostVaultUseDecision = z.infer<typeof HostVaultUseDecisionSchema>;
export type HostVaultEntry = z.infer<typeof HostVaultEntrySchema>;
export type HostVaultGrant = z.infer<typeof HostVaultGrantSchema>;
export type HostVaultAccess = z.infer<typeof HostVaultAccessSchema>;
export type HostVaultApproval = z.infer<typeof HostVaultApprovalSchema>;
export type HostVaultValue = z.infer<typeof HostVaultValueSchema>;
export type HostVaultPush = z.infer<typeof HostVaultPushSchema>;
export type HostVaultCacheUnavailable = z.infer<typeof HostVaultCacheUnavailableSchema>;
export type HostVaultStatus = z.infer<typeof HostVaultStatusSchema>;
export type HostVaultRequestResolve = z.infer<typeof HostVaultRequestResolveSchema>;
