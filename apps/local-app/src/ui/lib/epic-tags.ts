const MERGED_PREFIX = 'merged:';

export function isMergedTag(tag: string): boolean {
  return tag.toLowerCase().startsWith(MERGED_PREFIX);
}

export function getMergedWorktree(tags: readonly string[] | null | undefined): string | null {
  if (!tags?.length) {
    return null;
  }
  const mergedTag = tags.find(isMergedTag);
  if (!mergedTag) {
    return null;
  }
  const worktree = mergedTag.slice(MERGED_PREFIX.length).trim();
  return worktree.length > 0 ? worktree : null;
}
