export const GITHUB_STAR_GH = Symbol('GITHUB_STAR_GH');

/** Whether the GitHub user that `gh` is logged in as has starred the repo. */
export type GithubStarCheckResult = 'starred' | 'not-starred' | 'unknown';

export interface GithubStarGh {
  /** `unknown` covers gh missing, logged out, offline, timeouts and unexpected answers. */
  isAlreadyStarred(): Promise<GithubStarCheckResult>;
  /** Resolves true only when gh starred the repo. */
  star(): Promise<boolean>;
}
