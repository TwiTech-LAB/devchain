import { or, sql, type SQL } from 'drizzle-orm';
import { skills } from '../../storage/db/schema';

const MAX_SEARCH_TOKENS = 10;

export interface ParsedSearchQuery {
  phrase: string;
  tokens: string[];
}

export interface SkillSearchFields {
  slug: string;
  name: string;
  displayName: string;
  description: string | null;
  shortDescription: string | null;
  compatibility: string | null;
}

export function parseSearchQuery(q: string): ParsedSearchQuery | null {
  const phrase = q.trim().toLowerCase();
  if (!phrase) return null;

  const rawTokens = phrase.split(/[\s,]+/).filter((t) => t.length > 0);
  const tokens = [...new Set(rawTokens)].slice(0, MAX_SEARCH_TOKENS);
  if (tokens.length === 0) return null;

  return { phrase, tokens };
}

export function escapeLikeWildcards(term: string): string {
  return term.replace(/[%_\\]/g, '\\$&');
}

function buildFieldsLike(pattern: string): SQL<unknown> {
  return sql`(
    lower(${skills.slug}) LIKE ${pattern} ESCAPE '\\'
    OR lower(${skills.name}) LIKE ${pattern} ESCAPE '\\'
    OR lower(${skills.displayName}) LIKE ${pattern} ESCAPE '\\'
    OR lower(coalesce(${skills.description}, '')) LIKE ${pattern} ESCAPE '\\'
    OR lower(coalesce(${skills.shortDescription}, '')) LIKE ${pattern} ESCAPE '\\'
    OR lower(coalesce(${skills.compatibility}, '')) LIKE ${pattern} ESCAPE '\\'
  )`;
}

export function buildSearchCondition(parsed: ParsedSearchQuery): SQL<unknown> {
  if (parsed.tokens.length === 1) {
    return buildFieldsLike(`%${escapeLikeWildcards(parsed.tokens[0])}%`);
  }

  const parts: SQL<unknown>[] = [];

  parts.push(buildFieldsLike(`%${escapeLikeWildcards(parsed.phrase)}%`));

  for (const token of parsed.tokens) {
    parts.push(buildFieldsLike(`%${escapeLikeWildcards(token)}%`));
  }

  return or(...parts)!;
}

export function scoreSkillRelevance(skill: SkillSearchFields, parsed: ParsedSearchQuery): number {
  let score = 0;

  const highFields = [
    skill.slug.toLowerCase(),
    skill.name.toLowerCase(),
    skill.displayName.toLowerCase(),
  ];

  const lowFields = [
    (skill.description ?? '').toLowerCase(),
    (skill.shortDescription ?? '').toLowerCase(),
    (skill.compatibility ?? '').toLowerCase(),
  ];

  if (parsed.tokens.length > 1) {
    if (highFields.some((f) => f.includes(parsed.phrase))) {
      score += 100;
    } else if (lowFields.some((f) => f.includes(parsed.phrase))) {
      score += 20;
    }
  }

  for (const token of parsed.tokens) {
    if (highFields.some((f) => f.includes(token))) {
      score += 10;
    } else if (lowFields.some((f) => f.includes(token))) {
      score += 1;
    }
  }

  return score;
}

export function sortByRelevance<T extends SkillSearchFields>(
  items: T[],
  parsed: ParsedSearchQuery,
): T[] {
  return [...items].sort((a, b) => {
    const scoreA = scoreSkillRelevance(a, parsed);
    const scoreB = scoreSkillRelevance(b, parsed);
    if (scoreB !== scoreA) return scoreB - scoreA;
    const nameCompare = a.name.localeCompare(b.name);
    if (nameCompare !== 0) return nameCompare;
    return a.slug.localeCompare(b.slug);
  });
}
