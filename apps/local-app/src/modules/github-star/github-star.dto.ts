import { z } from 'zod';

export const GITHUB_STAR_REPO = 'TwiTech-LAB/devchain';
export const GITHUB_STAR_REPO_URL = `https://github.com/${GITHUB_STAR_REPO}`;
export const GITHUB_STAR_INITIAL_THRESHOLD = 50;

/** Realtime hint on the `system` topic; clients reload state with `GET /api/github-star`. */
export const GITHUB_STAR_CHANGED_EVENT = 'github_star_changed';

export const GithubStarReasonSchema = z.enum(['phase-done', 'launches']);
export const GithubStarModeSchema = z.enum(['gh', 'web']);

export const GithubStarPendingSchema = z
  .object({
    id: z.string().min(1),
    reason: GithubStarReasonSchema,
    mode: GithubStarModeSchema,
  })
  .strict();

/** The `githubStar.state` settings row. */
export const GithubStarStateSchema = z
  .object({
    status: z.enum(['active', 'starred', 'dismissed']),
    launches: z.number().int().nonnegative(),
    threshold: z.number().int().positive(),
    cooldownUntil: z.string().datetime().nullable(),
    phaseDoneUsed: z.boolean(),
    pending: GithubStarPendingSchema.nullable(),
  })
  .strict();

export const GithubStarActionSchema = z.enum(['star', 'later', 'never', 'opened']);

export const GithubStarActionRequestSchema = z
  .object({
    promptId: z.string().min(1).max(128),
    action: GithubStarActionSchema,
  })
  .strict();

export type GithubStarReason = z.infer<typeof GithubStarReasonSchema>;
export type GithubStarPending = z.infer<typeof GithubStarPendingSchema>;
export type GithubStarState = z.infer<typeof GithubStarStateSchema>;
export type GithubStarAction = z.infer<typeof GithubStarActionSchema>;

export function defaultGithubStarState(): GithubStarState {
  return {
    status: 'active',
    launches: 0,
    threshold: GITHUB_STAR_INITIAL_THRESHOLD,
    cooldownUntil: null,
    phaseDoneUsed: false,
    pending: null,
  };
}

export interface GithubStarPendingView extends GithubStarPending {
  url: string;
}

export interface GithubStarStateResponse {
  pending: GithubStarPendingView | null;
}

/**
 * `result` is set only for `star`: `starred` when gh starred the repo, `fallback`
 * when the card must show the repo link instead (`url`).
 */
export interface GithubStarActionResponse extends GithubStarStateResponse {
  result?: 'starred' | 'fallback';
  url?: string;
}
