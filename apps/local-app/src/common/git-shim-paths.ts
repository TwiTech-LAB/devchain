import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

/** The shim's directory, or null where sessions never use it; they put it first on PATH once installed. */
export const GIT_SHIM_BIN = Symbol('GIT_SHIM_BIN');

/** Whether this instance is a claimed VM; read on each use, because a claim can come later. */
export const GIT_SHIM_ON_VM = Symbol('GIT_SHIM_ON_VM');

/** Where the CLI writes the git shim and DevChain writes its project and state files. */
export function gitShimHome(home: string = homedir()): string {
  return join(home, '.devchain', 'git-shim');
}

export function gitShimBin(home?: string): string {
  return join(gitShimHome(home), 'bin');
}

/**
 * Drops the shim directory from `env.PATH`, keeping the other entries in order.
 * The app calls this at startup so Git that DevChain runs itself never reaches
 * the shim; agent sessions add the shim back in their own launch environment.
 */
export function removeGitShimFromPath(
  env: NodeJS.ProcessEnv = process.env,
  shimBin: string = gitShimBin(),
): void {
  if (!env.PATH) return;
  const shim = resolve(shimBin);
  env.PATH = env.PATH.split(delimiter)
    .filter((entry) => entry === '' || resolve(entry) !== shim)
    .join(delimiter);
}
