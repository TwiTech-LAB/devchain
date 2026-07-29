import { PROMPT_TRANSFER_POLICY, partitionPromptsForTransfer } from './prompt-transfer';
import { getPromptType, PROMPT_TYPE } from './prompt-type';

export const INSTRUCTION_REFERENCE_PATTERN = /\[\[([^[\]]+)\]\]/g;
export const PROMPT_REFERENCE_PREFIX = 'prompt:';

export const PROMPT_REFERENCE_VALIDATION_CODE = 'skipped_prompt_references' as const;

export interface PromptReferenceIssue {
  promptTitle: string;
  profileNames: string[];
}

export interface PromptReferenceValidationFailure {
  success: false;
  mutationStarted: false;
  error: string;
  promptReferenceValidation: {
    code: typeof PROMPT_REFERENCE_VALIDATION_CODE;
    promptTitles: string[];
    issues: PromptReferenceIssue[];
  };
}

export function extractPromptReferenceTitles(instructions: string | null | undefined): string[] {
  if (!instructions) return [];

  const titles: string[] = [];
  for (const match of instructions.matchAll(INSTRUCTION_REFERENCE_PATTERN)) {
    const raw = match[1]?.trim();
    if (!raw?.startsWith(PROMPT_REFERENCE_PREFIX)) continue;

    const title = raw.slice(PROMPT_REFERENCE_PREFIX.length).trim();
    if (title) titles.push(title);
  }
  return titles;
}

export function findSkippedTemplatePromptReferences(
  profiles: ReadonlyArray<{ name: string; instructions?: string | null }>,
  prompts: ReadonlyArray<{ title: string; tags?: readonly string[] }>,
): PromptReferenceIssue[] {
  const partition = partitionPromptsForTransfer(prompts, PROMPT_TRANSFER_POLICY.Template);
  const transferredTitles = new Set(
    partition.transfer.map((prompt) => normalizeTitle(prompt.title)),
  );
  const skippedTitles = new Map<string, string>();
  for (const prompt of partition.retain) {
    const key = normalizeTitle(prompt.title);
    if (!skippedTitles.has(key)) skippedTitles.set(key, prompt.title);
  }

  const profileNamesByTitle = new Map<string, Set<string>>();
  for (const profile of profiles) {
    for (const referencedTitle of extractPromptReferenceTitles(profile.instructions)) {
      const key = normalizeTitle(referencedTitle);
      if (transferredTitles.has(key) || !skippedTitles.has(key)) continue;

      const profileNames = profileNamesByTitle.get(key) ?? new Set<string>();
      profileNames.add(profile.name);
      profileNamesByTitle.set(key, profileNames);
    }
  }

  return Array.from(profileNamesByTitle, ([key, profileNames]) => ({
    promptTitle: skippedTitles.get(key) ?? key,
    profileNames: Array.from(profileNames),
  }));
}

export function buildPromptReferenceValidationFailure(
  issues: readonly PromptReferenceIssue[],
): PromptReferenceValidationFailure | null {
  if (issues.length === 0) return null;

  const promptTitles = issues.map((issue) => issue.promptTitle);
  return {
    success: false,
    mutationStarted: false,
    error: `Template profiles reference prompts excluded from template transfer: ${promptTitles
      .map((title) => `"${title}"`)
      .join(', ')}`,
    promptReferenceValidation: {
      code: PROMPT_REFERENCE_VALIDATION_CODE,
      promptTitles,
      issues: issues.map((issue) => ({
        promptTitle: issue.promptTitle,
        profileNames: [...issue.profileNames],
      })),
    },
  };
}

export function rankPromptCandidatesSystemFirst<T extends { tags?: readonly string[] }>(
  candidates: readonly T[],
): T[] {
  const system: T[] = [];
  const other: T[] = [];

  for (const candidate of candidates) {
    const promptType = getPromptType(candidate.tags ?? [], PROMPT_TYPE.System);
    (promptType === PROMPT_TYPE.System ? system : other).push(candidate);
  }

  return [...system, ...other];
}

function normalizeTitle(title: string): string {
  return title.toLowerCase();
}
