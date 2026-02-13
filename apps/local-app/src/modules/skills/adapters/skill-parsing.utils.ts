import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import matter from 'gray-matter';
import { ValidationError } from '../../../common/errors/error-types';

const CONTROL_CHAR_REGEX = /[\u0000-\u001f\u007f]/;
const SAFE_SKILL_SEGMENT_REGEX = /^[A-Za-z0-9_-]+$/;
const DEFAULT_SKILL_MARKDOWN_FILE = 'SKILL.md';
const DEFAULT_SKILL_DIRECTORY_CANDIDATES = ['', 'skills', 'library'] as const;

export interface ParsedSkillMarkdown {
  frontmatter: Record<string, unknown>;
  instructionContent: string;
}

export interface ParseSkillMarkdownOptions {
  skillMarkdownFileName?: string;
  onMissingFile?: (context: { skillMdPath: string }) => void;
  onParseError?: (context: { skillMdPath: string; error: unknown }) => void;
}

export interface ResolveSkillDirectoryOptions {
  candidates?: readonly string[];
  onCandidateError?: (context: { candidate: string; error: unknown }) => void;
}

export class SkillDirectoryNotFoundError extends Error {
  readonly skillName: string;
  readonly extractedRepoRoot: string;
  readonly candidates: readonly string[];

  constructor(
    skillName: string,
    extractedRepoRoot: string,
    candidates: readonly string[],
    message = 'Skill directory was not found in extracted repository tarball.',
  ) {
    super(message);
    this.name = 'SkillDirectoryNotFoundError';
    this.skillName = skillName;
    this.extractedRepoRoot = extractedRepoRoot;
    this.candidates = candidates;
  }
}

export async function parseSkillMarkdown(
  skillDirectory: string,
  options: ParseSkillMarkdownOptions = {},
): Promise<ParsedSkillMarkdown | null> {
  const safeSkillDirectory = resolve(skillDirectory);
  const skillMdPath = join(
    safeSkillDirectory,
    options.skillMarkdownFileName ?? DEFAULT_SKILL_MARKDOWN_FILE,
  );

  let markdown: string;
  try {
    markdown = await fs.readFile(skillMdPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      options.onMissingFile?.({ skillMdPath });
      return null;
    }
    throw error;
  }

  try {
    const parsed = matter(markdown);
    const frontmatter =
      parsed.data && typeof parsed.data === 'object'
        ? (parsed.data as Record<string, unknown>)
        : {};
    return {
      frontmatter,
      instructionContent: parsed.content,
    };
  } catch (error) {
    options.onParseError?.({ skillMdPath, error });
    return null;
  }
}

export async function resolveSkillDirectory(
  extractedRepoRoot: string,
  skillName: string,
  options: ResolveSkillDirectoryOptions = {},
): Promise<string> {
  const safeExtractedRepoRoot = resolve(extractedRepoRoot);
  const candidates = (options.candidates ?? DEFAULT_SKILL_DIRECTORY_CANDIDATES).map((candidate) =>
    candidate
      ? join(safeExtractedRepoRoot, candidate, skillName)
      : join(safeExtractedRepoRoot, skillName),
  );

  for (const candidate of candidates) {
    try {
      const stats = await fs.stat(candidate);
      if (stats.isDirectory()) {
        return candidate;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        options.onCandidateError?.({ candidate, error });
        throw error;
      }
    }
  }

  throw new SkillDirectoryNotFoundError(skillName, safeExtractedRepoRoot, candidates);
}

export function validatePathSegment(segment: string, fieldName: string): string {
  const trimmed = segment.trim();
  if (!trimmed) {
    throw new ValidationError(`Invalid ${fieldName}: value cannot be empty.`, { fieldName });
  }
  if (
    trimmed.includes('..') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    CONTROL_CHAR_REGEX.test(trimmed)
  ) {
    throw new ValidationError(
      `Invalid ${fieldName}: path traversal or control characters are not allowed.`,
      { fieldName, segment: trimmed },
    );
  }
  if (!SAFE_SKILL_SEGMENT_REGEX.test(trimmed)) {
    throw new ValidationError(
      `Invalid ${fieldName}: only alphanumeric characters, underscores, and hyphens are allowed.`,
      { fieldName, segment: trimmed },
    );
  }
  return trimmed;
}

export function pickString(
  frontmatter: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = toStringValue(frontmatter[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function pickStringArray(
  frontmatter: Record<string, unknown>,
  keys: readonly string[],
): string[] {
  for (const key of keys) {
    const value = frontmatter[key];
    if (!Array.isArray(value)) {
      continue;
    }

    const items = value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (items.length > 0) {
      return items;
    }
  }

  return [];
}

function toStringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  if (Array.isArray(value)) {
    const items = value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (items.length > 0) {
      return items.join(', ');
    }
  }

  return undefined;
}
