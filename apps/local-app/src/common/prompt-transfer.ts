import { getPromptType, PROMPT_TYPE } from './prompt-type';

export const PROMPT_TRANSFER_POLICY = {
  Template: 'template',
  Snapshot: 'snapshot',
} as const;

export type PromptTransferPolicy =
  (typeof PROMPT_TRANSFER_POLICY)[keyof typeof PROMPT_TRANSFER_POLICY];

export interface PromptTransferCounts {
  imported: number;
  deleted: number;
  preserved: number;
  skipped: number;
}

export interface PromptTransferPartition<T> {
  transfer: T[];
  retain: T[];
}

export interface PromptReplacementPlan {
  deleteIds: string[];
  preserveIds: string[];
}

export function partitionPromptsForTransfer<T extends { tags?: readonly string[] }>(
  prompts: readonly T[],
  _policy: PromptTransferPolicy,
): PromptTransferPartition<T> {
  return { transfer: [...prompts], retain: [] };
}

export function planPromptReplacement<
  TIncoming extends { title: string; tags?: readonly string[] },
  TExisting extends { id: string; title: string; tags?: readonly string[] },
>(
  incoming: readonly TIncoming[],
  existing: readonly TExisting[],
  policy: PromptTransferPolicy,
): PromptReplacementPlan {
  if (policy === PROMPT_TRANSFER_POLICY.Snapshot) {
    return {
      deleteIds: existing.map((prompt) => prompt.id),
      preserveIds: [],
    };
  }

  const incomingCustomTitles = new Set(
    incoming
      .filter(
        (prompt) => getPromptType(prompt.tags ?? [], PROMPT_TYPE.System) === PROMPT_TYPE.Custom,
      )
      .map((prompt) => prompt.title.toLowerCase()),
  );
  const deleteIds: string[] = [];
  const preserveIds: string[] = [];

  for (const prompt of existing) {
    const promptType = getPromptType(prompt.tags ?? [], PROMPT_TYPE.System);
    const shouldDelete =
      promptType === PROMPT_TYPE.System || incomingCustomTitles.has(prompt.title.toLowerCase());
    (shouldDelete ? deleteIds : preserveIds).push(prompt.id);
  }

  return { deleteIds, preserveIds };
}

export function formatPromptTransferCounts(counts: PromptTransferCounts): string {
  return (
    `${counts.imported} imported, ${counts.deleted} deleted, ` +
    `${counts.preserved} preserved, ${counts.skipped} skipped`
  );
}
