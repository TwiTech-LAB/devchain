import { z } from 'zod';
import { IgnorePatternsSchema } from './file-sync.dto';

const absolute = (path: string) => /^(?:\/|[A-Za-z]:[\\/])/.test(path);

export const SyncRelativePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !absolute(path) &&
      !/[\\\x00\r\n]/.test(path) &&
      path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'Expected a relative project path without traversal',
  );
export const SyncInspectRequestSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (path) => absolute(path) && !path.includes('\0'),
        'Expected an absolute project root',
      ),
    scan: z.boolean(),
    paths: z.array(SyncRelativePathSchema),
    patterns: IgnorePatternsSchema.optional(),
  })
  .strict();
export type SyncInspectRequest = z.infer<typeof SyncInspectRequestSchema>;
export const SyncSuggestionsRequestSchema = z.object({ remoteId: z.string().uuid() }).strict();

export const SyncPathOwnerSchema = z.object({
  uid: z.number().int().nonnegative(),
  name: z.string(),
});
export type SyncPathOwner = z.infer<typeof SyncPathOwnerSchema>;
export const SyncIgnoreRuleSchema = z.object({
  source: z.string(),
  line: z.number().int(),
  pattern: z.string(),
});
export const SyncPathFactsSchema = z.object({
  path: SyncRelativePathSchema,
  kind: z.enum(['file', 'folder', 'missing']),
  owner: SyncPathOwnerSchema,
  foreignOwner: z.boolean(),
  foreignOwners: z.array(SyncPathOwnerSchema),
  fileCount: z.number().int().nonnegative(),
  ignored: z.boolean().nullable(),
  ignoreRule: SyncIgnoreRuleSchema.nullable(),
  ignoreRules: z.array(SyncIgnoreRuleSchema),
  ignoredAncestor: SyncRelativePathSchema.nullable(),
  tracked: z.boolean().nullable(),
  trackedDescendants: z.array(SyncRelativePathSchema).nullable(),
});
export type SyncPathFacts = z.infer<typeof SyncPathFactsSchema>;
/** The path itself, or a path below it (both relative, `/`-separated). */
export const within = (child: string, parent: string) =>
  child === parent || child.startsWith(parent + '/');
/** The proper ancestors of a relative path, shallowest first. */
export function ancestors(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

export const SYNC_PATTERN_TRACKED_FILES_MAX = 50;
export const SYNC_PATTERN_KEPT_SAMPLE_MAX = 5;
export const SyncPatternChecksSchema = z.object({
  state: z.enum(['checked', 'no-root', 'no-repo', 'error']),
  error: z.string().optional(),
  results: z.array(
    z.object({
      pattern: z.string(),
      tracked: z.object({
        count: z.number().int().nonnegative(),
        files: z.array(z.string()).max(SYNC_PATTERN_TRACKED_FILES_MAX),
        complete: z.boolean(),
      }),
      kept: z.object({
        count: z.number().int().nonnegative(),
        sample: z.array(z.string()).max(SYNC_PATTERN_KEPT_SAMPLE_MAX),
      }),
    }),
  ),
});
export type SyncPatternChecks = z.infer<typeof SyncPatternChecksSchema>;

export const SyncPathInspectionSchema = z.object({
  rootPath: z.string(),
  exists: z.boolean(),
  repository: z.boolean(),
  projectOwner: SyncPathOwnerSchema.nullable(),
  vmUser: SyncPathOwnerSchema.optional(),
  gitState: z.enum(['repo', 'no-repo', 'error']),
  gitError: z.string().optional(),
  candidates: z.array(SyncRelativePathSchema),
  requestedPaths: z.array(SyncRelativePathSchema),
  /** Requested paths that a folder this user cannot search hides; their facts are unknown. */
  hiddenPaths: z.array(SyncRelativePathSchema).optional(),
  entries: z.array(SyncPathFactsSchema),
  patternChecks: SyncPatternChecksSchema.optional(),
});
export type SyncPathInspection = z.infer<typeof SyncPathInspectionSchema>;

export interface ExclusionSuggestion {
  path: string;
  pathCount?: number;
  pathSample?: string[];
  patternChecksPassed?: boolean;
  side: 'home' | 'vm';
  owner: SyncPathOwner;
  home: SyncPathFacts | null;
  vm: SyncPathFacts | null;
  fileCount: number;
  reason: string;
  reasonKind: 'foreignOwner' | 'untracked';
  selected: boolean;
  /** Tracked exceptions precede the folder exclusion in this atomic group. */
  patterns: string[];
  pattern?: string;
  blockedBy?: string;
  gitUnchecked?: boolean;
  chown?: Partial<Record<'home' | 'vm', string>>;
  patternError?: string;
}
export interface ExclusionSuggestions {
  groups: ExclusionSuggestion[];
  overLimit: boolean;
}

/** A suggestion row's identity within one scan: its side and representative path. */
export const exclusionGroupKey = (group: Pick<ExclusionSuggestion, 'side' | 'path'>) =>
  `${group.side}:${group.path}`;
export const EXCLUSION_LIMIT_ERROR =
  'These paths cannot fit within the remaining exclusion pattern limit.';

export function isSelectableExclusion(group: ExclusionSuggestion): boolean {
  return (
    group.patterns.length > 0 &&
    !group.blockedBy &&
    !group.gitUnchecked &&
    !group.chown &&
    !group.patternError
  );
}
export function isGiveOwnershipEligible(group: ExclusionSuggestion): boolean {
  return (
    !group.gitUnchecked &&
    !!group.vm &&
    (group.vm.foreignOwner || group.vm.foreignOwners.length > 0) &&
    group.vm.tracked === false &&
    group.vm.ignored === false
  );
}
export interface ProjectExclusionSuggestions extends ExclusionSuggestions {
  ownerSide: 'home' | 'vm';
  home: SyncPathInspection;
  vm: SyncPathInspection | 'unavailable';
}
