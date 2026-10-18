import { z } from 'zod';

const IdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/)
  .refine((id) => !['__proto__', 'constructor', 'prototype'].includes(id));
export const GitFenceSchema = z.object({
  expectedGeneration: z.number().int().nonnegative(),
  transitionId: IdSchema.nullable(),
});
export type GitFence = z.infer<typeof GitFenceSchema>;
export const GitFenceQuerySchema = z.object({
  expectedGeneration: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().nonnegative()),
  transitionId: z
    .string()
    .transform((id) => (id === 'none' ? null : id))
    .pipe(IdSchema.nullable()),
});

export const VmHoldRequestSchema = z
  .object({
    holdId: IdSchema,
    pid: z.number().int().positive(),
    processStartTime: z.string().min(1).max(256),
  })
  .strict();
export type VmHoldRequest = z.infer<typeof VmHoldRequestSchema>;
export const VmHoldSchema = VmHoldRequestSchema.omit({ holdId: true }).extend({
  startedAt: z.number(),
});

/** Handover phases in order; the VM journals each one before its effect. */
export const HANDOVER_PHASES = ['draining', 'vm-receiving', 'home-sending', 'published'] as const;
const HandoverPhase = z.enum(HANDOVER_PHASES);

export const GitCheckpointSchema = z.object({
  writeId: IdSchema,
  generation: z.number().int().nonnegative(),
  refsDigest: z.string().min(1).max(256),
  at: z.number(),
});
export const GitWriteResultSchema = GitCheckpointSchema.omit({ writeId: true });
export const GitTransitionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('handover'),
    id: IdSchema,
    phase: HandoverPhase,
    lease: z.number(),
    /** The VM's local Syncthing sequence per folder id, recorded once its holds drained. */
    sequences: z.record(z.number().int().nonnegative()).optional(),
  }),
  z.object({
    kind: z.literal('reclaim'),
    id: IdSchema,
    phase: z.enum(['sending', 'unguarding', 'index', 'publishing']),
    lease: z.null(),
  }),
]);
export const GitCoordinatorRecordSchema = z.object({
  owner: z.enum(['vm', 'home']),
  generation: z.number().int().nonnegative(),
  homeName: z.string().min(1).max(255).nullable(),
  homeWrites: z.record(z.number()),
  checkpoint: GitCheckpointSchema.nullable(),
  /** The most recent confirmed home writes, so a retried confirmation gets its own result. */
  confirmedWrites: z.record(GitWriteResultSchema).optional(),
  vmHolds: z.record(VmHoldSchema),
  transition: GitTransitionSchema.nullable(),
  /** Set while the project disconnects: in-flight work finishes, nothing new is admitted. */
  closed: z.boolean().optional(),
});
export type GitCoordinatorRecord = z.infer<typeof GitCoordinatorRecordSchema>;
/** `worktreeBranches`: full refs checked out in the VM's linked worktrees, managed or not. */
export const GitCoordinatorStatusSchema = GitCoordinatorRecordSchema.extend({
  worktreeBranches: z.array(
    z
      .string()
      .regex(/^refs\/heads\/[^\0\n]+$/)
      .max(1024),
  ),
});
export type GitCoordinatorStatus = z.infer<typeof GitCoordinatorStatusSchema>;
export type GitTransition = z.infer<typeof GitTransitionSchema>;

export const HomeWriteBeginSchema = GitFenceSchema.extend({
  writeId: IdSchema,
  homeName: z.string().trim().min(1).max(255),
}).strict();
const IndexBase64Schema = z
  .string()
  .max(64 * 1024 * 1024)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
/** A self-contained root index; empty when the repository has none. */
export const GitIndexSnapshotSchema = z.object({ indexBase64: IndexBase64Schema }).strict();
export const HomeWriteEndSchema = GitFenceSchema.extend({
  writeId: IdSchema,
  refsDigest: z.string().min(1).max(256),
  // The caller confirms the sync barrier before submitting the checkpoint; the VM checks refs and objects.
  indexBase64: IndexBase64Schema,
}).strict();
export const HandoverBeginSchema = GitFenceSchema.extend({
  id: IdSchema,
  homeName: z.string().trim().min(1).max(255),
}).strict();
export const HandoverPhaseSchema = GitFenceSchema.extend({
  phase: HandoverPhase,
  /** The home write the handover is for; publishing registers it with the ownership move. */
  writeId: IdSchema.optional(),
})
  .strict()
  .refine((request) => request.phase !== 'published' || request.writeId, {
    message: 'Publishing a handover needs the home write id',
    path: ['writeId'],
  });
