import type { CreatePrompt, Prompt } from '../models/domain.models';

/**
 * Trusted recovery capability. It is deliberately separate from StorageService so
 * normal application writes cannot opt out of prompt type canonicalization.
 */
export interface SnapshotPromptWriter {
  createPromptFromSnapshot(data: CreatePrompt): Promise<Prompt>;
}

export const SNAPSHOT_PROMPT_WRITER = Symbol('SNAPSHOT_PROMPT_WRITER');
