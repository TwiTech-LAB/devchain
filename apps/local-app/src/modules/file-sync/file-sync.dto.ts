import { z } from 'zod';

/** A Syncthing device id: eight dash-separated groups of seven base32 characters. */
export const DeviceIdSchema = z.string().regex(/^[A-Z2-7]{7}(-[A-Z2-7]{7}){7}$/);

export const PeerAddressSchema = z
  .string()
  .max(256)
  .regex(/^(tcp|quic):\/\/\S+$|^dynamic$/);

export const FolderTypeSchema = z.enum(['sendonly', 'receiveonly', 'sendreceive']);
export type FolderType = z.infer<typeof FolderTypeSchema>;

export const FolderIdSchema = z
  .string()
  .max(200)
  .regex(/^((?:code|git):[^:\s]+|tx:[a-z0-9-]+:[^:\s]+)$/);

/** The cap of each ignore list: the user's own, and the patterns DevChain manages. */
export const IGNORE_PATTERNS_MAX = 200;
/** The longest ignore pattern the server accepts. */
export const IGNORE_PATTERN_MAX_LENGTH = 256;
const IgnorePatternSchema = z.string().min(1).max(IGNORE_PATTERN_MAX_LENGTH);
export const IgnorePatternsSchema = z.array(IgnorePatternSchema).max(IGNORE_PATTERNS_MAX);

/**
 * Build and dependency directories no project needs on both sides. `(?d)`
 * lets Syncthing delete an ignored directory when its parent is deleted.
 * `.env` files are deliberately not ignored; `.gitignore` is never consulted.
 */
export const DEFAULT_FILE_SYNC_IGNORES: readonly string[] = [
  'node_modules',
  'dist',
  'build',
  '.next',
  'target',
  '.venv',
  '__pycache__',
  '.turbo',
  'coverage',
].map((name) => `(?d)${name}`);
export const CODE_SYSTEM_IGNORE = '/.git';

/** The code folder's installed ignores: the system pattern, then managed exclusions, then the user's. */
export function codeIgnores(managed: string[], user: string[]): string[] {
  // Syncthing uses the first matching pattern: managed exclusions must precede
  // user negations. Keep this union out of the user's editable ignore list.
  return [...new Set([CODE_SYSTEM_IGNORE, ...managed, ...user])];
}

/** The git folder's ignores; hooks and index stay per side once the VM owns git. */
export function gitIgnores(connected: boolean): string[] {
  return connected ? ['*.lock', '/hooks', '/index'] : ['*.lock'];
}
/** The leading system pattern does not consume either editable list's allowance. */
export const FolderIgnoresSchema = z
  .array(IgnorePatternSchema)
  .max(2 * IGNORE_PATTERNS_MAX + 1)
  .refine(
    (patterns) => patterns.length <= 2 * IGNORE_PATTERNS_MAX || patterns[0] === CODE_SYSTEM_IGNORE,
    'Only the leading system pattern is outside the installed ignore cap',
  );

export const SyncDeviceSchema = z.object({ deviceId: DeviceIdSchema, address: PeerAddressSchema });
export type SyncDevice = z.infer<typeof SyncDeviceSchema>;

export const SyncFolderRequestSchema = z
  .object({
    projectId: z.string().trim().min(1).max(128),
    kind: z.enum(['code', 'git']),
    type: FolderTypeSchema,
    peerDeviceId: DeviceIdSchema,
    ignores: FolderIgnoresSchema,
    /** Leaves the folder paused, so the caller can unpause both sides in order. */
    paused: z.boolean().optional(),
  })
  .strict();
export type SyncFolderRequest = z.infer<typeof SyncFolderRequestSchema>;

export const SyncFolderSchema = z.object({
  id: FolderIdSchema,
  path: z.string(),
  type: FolderTypeSchema,
  paused: z.boolean(),
});
export type SyncFolder = z.infer<typeof SyncFolderSchema>;

export const SyncFolderPatchSchema = z
  .object({
    type: FolderTypeSchema.optional(),
    paused: z.boolean().optional(),
    ignores: FolderIgnoresSchema.optional(),
  })
  .strict()
  .refine(
    (patch) =>
      patch.type !== undefined || patch.paused !== undefined || patch.ignores !== undefined,
    {
      message: 'type, paused or ignores is required',
    },
  );
export type SyncFolderPatch = z.infer<typeof SyncFolderPatchSchema>;

export const SyncStatusQuerySchema = z
  .object({ folder: FolderIdSchema, device: DeviceIdSchema.optional() })
  .strict();

export const FolderSyncStatusSchema = z.object({
  folderId: z.string(),
  state: z.string(),
  error: z.string().optional(),
  errors: z.number().optional(),
  localFiles: z.number(),
  localDirectories: z.number(),
  globalFiles: z.number(),
  globalDirectories: z.number(),
  needTotalItems: z.number(),
  needBytes: z.number(),
  receiveOnlyChangedFiles: z.number(),
  /** This side's view of the peer's copy; present when the status was asked for a device. */
  peer: z
    .object({
      deviceId: z.string(),
      completion: z.number(),
      needItems: z.number(),
      needBytes: z.number(),
      remoteState: z.string(),
    })
    .nullable(),
});
export type FolderSyncStatus = z.infer<typeof FolderSyncStatusSchema>;

/** `null` returns the project to the default patterns. */
export const IgnoresBodySchema = z.object({ ignores: IgnorePatternsSchema.nullable() }).strict();
