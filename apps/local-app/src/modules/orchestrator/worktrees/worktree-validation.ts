export const MAX_WORKTREE_NAME_LENGTH = 63;
export const WORKTREE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const INVALID_BRANCH_CONTROL_OR_SPACE = /[\x00-\x20\x7f]/;
const INVALID_BRANCH_CHARS = /[~^:?*\[]/;

export function isValidWorktreeName(name: string): boolean {
  if (typeof name !== 'string') {
    return false;
  }
  return WORKTREE_NAME_PATTERN.test(name);
}

export function isValidGitBranchName(name: string): boolean {
  if (typeof name !== 'string' || name.length < 1 || name.length > 255) {
    return false;
  }

  if (INVALID_BRANCH_CONTROL_OR_SPACE.test(name)) {
    return false;
  }

  if (
    name.includes('..') ||
    name.includes('@{') ||
    name.includes('//') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.startsWith('.') ||
    name.endsWith('.') ||
    name.endsWith('.lock')
  ) {
    return false;
  }

  if (INVALID_BRANCH_CHARS.test(name)) {
    return false;
  }

  const segments = name.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return false;
  }

  return true;
}
