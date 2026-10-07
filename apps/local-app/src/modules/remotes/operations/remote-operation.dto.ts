import { z } from 'zod';
import { SshPublicKeysSchema } from '../../../common/validation/ssh-public-key';
import { REMOTE_OPERATION_STATE_IDS } from '../../storage/models/domain.models';
import {
  BASE_URL_MESSAGE,
  CERTIFICATE_FINGERPRINT_MESSAGE,
  CertificateFingerprintSchema,
  normalizeRemoteBaseUrl,
} from '../dtos/remote.dto';
import { DockerSelectionSchema } from '../docker/docker-plan.dto';
import { DockerCopyBackRequestSchema } from '../docker/docker-copy-back.dto';

export const RemoteOperationIdSchema = z.string().uuid();

export const ForceSyncSourceSchema = z.enum(['home', 'vm']);
export type ForceSyncSource = z.infer<typeof ForceSyncSourceSchema>;
export const ForceSyncProjectSchema = z
  .object({ projectId: z.string().min(1), source: ForceSyncSourceSchema })
  .strict();

export const AttachProjectSchema = z
  .object({
    projectId: z.string().min(1),
    docker: DockerSelectionSchema.optional(),
  })
  .strict();

export const DetachProjectSchema = z
  .object({
    projectId: z.string().min(1),
    force: z.boolean().optional().default(false),
    /** "Copy Docker data back to this PC"; absent means off. A forced disconnect ignores it. */
    dockerCopyBack: DockerCopyBackRequestSchema.optional(),
  })
  .strict();

export const ListRemoteOperationsQuerySchema = z
  .object({
    projectId: z.string().min(1).optional(),
    state: z.enum(REMOTE_OPERATION_STATE_IDS).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

/** `reuse:<entryId>`, `generate` or `skip`, per provider. */
const ProviderAuthChoiceSchema = z.union([
  z.literal('generate'),
  z.literal('skip'),
  z.string().regex(/^reuse:[0-9a-f-]{36}$/i, 'reuse:<entryId>'),
]);

export const ProviderAuthSelectionSchema = z.record(
  z.string().trim().toLowerCase().min(1).max(32),
  ProviderAuthChoiceSchema,
);

export type ProviderAuthSelection = z.infer<typeof ProviderAuthSelectionSchema>;

/** The setup choices every claim path accepts: logins, Docker and SSH public keys. */
export const ClaimChoiceFields = {
  providerAuth: ProviderAuthSelectionSchema.default({}),
  installDocker: z.boolean().optional(),
  sshPublicKeys: SshPublicKeysSchema.optional(),
};

export const ClaimRemoteSchema = z
  .object({
    remoteId: z.string().uuid().optional(),
    /** The unclaimed VM's address; the remote is created for it. */
    baseUrl: z.string().optional(),
    /** Read on the VM itself; required with `baseUrl`, whose certificate must match it. */
    certificateFingerprint: CertificateFingerprintSchema.optional(),
    name: z.string().trim().min(1).max(128).optional(),
    port: z.number().int().min(1024).max(65535).optional(),
    ...ClaimChoiceFields,
  })
  .strict()
  .refine((body) => (body.remoteId === undefined) !== (body.baseUrl === undefined), {
    message: 'Give either remoteId or baseUrl.',
  })
  .refine((body) => body.baseUrl === undefined || body.certificateFingerprint !== undefined, {
    message: CERTIFICATE_FINGERPRINT_MESSAGE,
    path: ['certificateFingerprint'],
  })
  .refine((body) => body.remoteId === undefined || body.certificateFingerprint === undefined, {
    message:
      'A registered remote keeps its certificate; give certificateFingerprint only with baseUrl.',
    path: ['certificateFingerprint'],
  });

export type ClaimRemoteData = z.infer<typeof ClaimRemoteSchema>;

export const MAX_SSH_PRIVATE_KEY_BYTES = 1_000_000;

export const SshCredentialsSchema = z
  .object({
    user: z.string().trim().min(1).max(128),
    password: z.string().min(1).max(16_384).optional(),
    privateKey: z.string().min(1).max(MAX_SSH_PRIVATE_KEY_BYTES).optional(),
    keyName: z.string().trim().min(1).max(255).optional(),
    passphrase: z.string().max(16_384).optional(),
    sudoPassword: z.string().max(16_384).optional(),
  })
  .strict()
  .refine(
    (ssh) =>
      [ssh.password, ssh.privateKey, ssh.keyName].filter((value) => value !== undefined).length ===
      1,
    {
      message: 'Give exactly one SSH password, private key or key name.',
    },
  )
  .refine(
    (ssh) =>
      ssh.privateKey !== undefined || ssh.keyName !== undefined || ssh.passphrase === undefined,
    {
      message: 'An SSH passphrase applies only to a private key.',
    },
  );

const InstallHostAddressSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .transform((value, context) => {
    const candidate = value.includes('://') ? value : `https://${value}`;
    const origin = normalizeRemoteBaseUrl(candidate);
    if (!origin) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: BASE_URL_MESSAGE });
      return z.NEVER;
    }
    return origin;
  });

export const InstallHostSchema = z
  .object({
    address: InstallHostAddressSchema,
    ssh: SshCredentialsSchema,
    name: z.string().trim().min(1).max(128).optional(),
    minDiskGib: z.number().int().min(1).max(1_000_000),
    ...ClaimChoiceFields,
  })
  .strict();

export type InstallHostData = z.infer<typeof InstallHostSchema>;

export const RetryRemoteOperationSchema = z
  .object({
    /** For a claim whose login check failed: new choices for those providers. */
    providerAuth: ProviderAuthSelectionSchema.optional(),
    /** In-memory SSH credentials needed again after a home restart. */
    ssh: SshCredentialsSchema.optional(),
  })
  .strict();

export const UpdateHostSchema = z.object({ installDocker: z.literal(true).optional() }).strict();

export const UpdateLoginsSchema = z
  .object({
    providerAuth: ProviderAuthSelectionSchema.refine(
      (value) => Object.keys(value).length > 0,
      'Choose at least one changed provider.',
    ),
    force: z.boolean().default(false),
  })
  .strict();
export type UpdateLoginsData = z.infer<typeof UpdateLoginsSchema>;
