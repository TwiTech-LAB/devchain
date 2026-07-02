import { dirname } from 'path';

/**
 * Neutral, provider-agnostic trust-folders pure logic.
 *
 * These helpers resolve the effective trust of a project path against a
 * gemini-family `trustedFolders.json` rule map (`"<abs-path>": "<TRUST_LEVEL>"`).
 * The shared `~/.gemini/trustedFolders.json` store is reused by multiple
 * providers (e.g. agy), so this logic lives in a neutral module with no
 * provider-specific ownership or side effects — it performs no I/O.
 */

export type TrustLevel = 'TRUST_FOLDER' | 'TRUST_PARENT' | 'DO_NOT_TRUST';

export type EffectiveTrust =
  | { kind: 'trusted'; via: 'exact' | 'ancestor' | 'parent_rule' }
  | { kind: 'distrusted'; via: 'exact' | 'ancestor' }
  | { kind: 'no_rule' };

function isSubpath(parent: string, child: string): boolean {
  if (parent === child) return true;
  const parentWithSep = parent.endsWith('/') ? parent : parent + '/';
  return child.startsWith(parentWithSep);
}

export function getEffectiveTrust(
  projectPath: string,
  rules: Record<string, TrustLevel>,
): EffectiveTrust {
  let bestMatch: { effectivePath: string; level: TrustLevel; rulePath: string } | null = null;

  for (const [rulePath, level] of Object.entries(rules)) {
    const effectivePath = level === 'TRUST_PARENT' ? dirname(rulePath) : rulePath;

    if (!isSubpath(effectivePath, projectPath)) continue;

    if (!bestMatch || effectivePath.length > bestMatch.effectivePath.length) {
      bestMatch = { effectivePath, level, rulePath };
    }
  }

  if (!bestMatch) return { kind: 'no_rule' };

  if (bestMatch.level === 'DO_NOT_TRUST') {
    const via = bestMatch.effectivePath === projectPath ? 'exact' : 'ancestor';
    return { kind: 'distrusted', via };
  }

  if (bestMatch.level === 'TRUST_FOLDER') {
    const via = bestMatch.effectivePath === projectPath ? 'exact' : 'ancestor';
    return { kind: 'trusted', via };
  }

  return { kind: 'trusted', via: 'parent_rule' };
}
