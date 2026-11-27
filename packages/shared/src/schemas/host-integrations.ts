import { z } from 'zod';
import { HostVaultCacheUnavailableSchema } from './host-vault.js';
import { ReplicaExternalTaskLinkRowSchema } from './project-replica.js';

/**
 * Home → claimed VM delivery of ClickUp/Jira connections for the projects the VM holds.
 * `connections` is metadata only and always present; `secrets` carries credentials and
 * is never logged or echoed in an error. The VM keeps the metadata in its DB and the
 * credentials in a tmpfs file only.
 */
export const HOST_INTEGRATIONS_CONTENT_TYPE = 'application/vnd.devchain.host-integrations+json';
/** Above the app-wide 1 MiB JSON limit: a seed can carry every link of a project. */
export const HOST_INTEGRATIONS_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
export const HOST_INTEGRATIONS_MAX_CONNECTIONS = 1000;

const Id = z.string().min(1).max(128);
const Secret = z.string().min(1).max(4096);
const Provider = z.enum(['clickup', 'jira']);

export const HostIntegrationConnectionSchema = z
  .object({
    /** The connection id at home. */
    id: Id,
    projectId: Id,
    provider: Provider,
    /** Changes whenever home replaces the credentials. */
    generation: z.number().int().positive(),
  })
  .strict();

export const HostIntegrationCredentialsSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('clickup'), token: Secret }).strict(),
  z
    .object({
      provider: z.literal('jira'),
      siteUrl: z.string().min(1).max(2048),
      email: z.string().min(1).max(320),
      token: Secret,
    })
    .strict(),
]);

export const HostIntegrationSecretSchema = z
  .object({
    connectionId: Id,
    generation: z.number().int().positive(),
    credentials: HostIntegrationCredentialsSchema,
  })
  .strict();

/**
 * Home's ordinary links of one project, sent while the VM reports it unseeded. The VM
 * takes the first seed of a project and ignores the rest, so a link it unlinked since
 * never comes back.
 */
export const HostIntegrationSeedSchema = z
  .object({ projectId: Id, links: z.array(ReplicaExternalTaskLinkRowSchema) })
  .strict()
  .refine((seed) => seed.links.every((link) => link.project_id === seed.projectId), {
    message: 'Seed links must belong to the seeded project',
  });

/** Home applied this VM link receipt; the VM may delete it. */
export const HostIntegrationReceiptAckSchema = z.object({ receiptId: Id }).strict();

export const HostIntegrationsPushSchema = z
  .object({
    /** `hostIntegrationsRevision` of `connections`; never covers credentials. */
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    connections: z.array(HostIntegrationConnectionSchema).max(HOST_INTEGRATIONS_MAX_CONNECTIONS),
    seed: z.array(HostIntegrationSeedSchema).optional(),
    acks: z.array(HostIntegrationReceiptAckSchema).optional(),
    /** Absent while home cannot read credentials; absence revokes nothing. */
    secrets: z.array(HostIntegrationSecretSchema).max(HOST_INTEGRATIONS_MAX_CONNECTIONS).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const connections = new Map(body.connections.map((connection) => [connection.id, connection]));
    if (connections.size !== body.connections.length)
      ctx.addIssue({ code: 'custom', message: 'Connection ids must be unique' });
    if (new Set(body.seed?.map((seed) => seed.projectId)).size !== (body.seed?.length ?? 0))
      ctx.addIssue({ code: 'custom', message: 'A project is seeded once per push' });
    const owners = new Set(body.connections.map((c) => `${c.projectId}\u0000${c.provider}`));
    if (owners.size !== body.connections.length)
      ctx.addIssue({ code: 'custom', message: 'A project has one connection per provider' });
    const delivered = new Set<string>();
    for (const secret of body.secrets ?? []) {
      const connection = connections.get(secret.connectionId);
      if (
        connection?.generation !== secret.generation ||
        connection.provider !== secret.credentials.provider ||
        delivered.has(secret.connectionId)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Each secret must match one listed connection generation and provider',
        });
      delivered.add(secret.connectionId);
    }
  });

/** Why a VM cannot hold credentials; home stops pushing until an Update VM fixes it. */
export const HostIntegrationsCacheUnavailableSchema = HostVaultCacheUnavailableSchema;

/** Reported in the VM runtime payload. Never carries a credential. */
export const HostIntegrationsStatusSchema = z.object({
  /** Revision of the connection metadata the VM holds. */
  appliedRevision: z.string(),
  /** True when the cache holds credentials for every connection at its generation. */
  cacheReady: z.boolean(),
  cacheUnavailable: HostIntegrationsCacheUnavailableSchema.nullable(),
  /** Projects whose ordinary links home seeded. Absent on a VM that takes no seed. */
  seededProjectIds: z.array(z.string()).optional(),
  /** Link receipts home has not acknowledged yet. */
  pendingReceipts: z.number().int().nonnegative().optional(),
});

/** The VM's answer to a push. */
export const HostIntegrationsPutResultSchema = z
  .object({ revision: z.string(), seededProjectIds: z.array(z.string()).optional() })
  .strict();

export type HostIntegrationConnection = z.infer<typeof HostIntegrationConnectionSchema>;
export type HostIntegrationCredentials = z.infer<typeof HostIntegrationCredentialsSchema>;
export type HostIntegrationSecret = z.infer<typeof HostIntegrationSecretSchema>;
export type HostIntegrationsPush = z.infer<typeof HostIntegrationsPushSchema>;
export type HostIntegrationsCacheUnavailable = z.infer<
  typeof HostIntegrationsCacheUnavailableSchema
>;
export type HostIntegrationsStatus = z.infer<typeof HostIntegrationsStatusSchema>;
export type HostIntegrationSeed = z.infer<typeof HostIntegrationSeedSchema>;
export type HostIntegrationsPutResult = z.infer<typeof HostIntegrationsPutResultSchema>;
