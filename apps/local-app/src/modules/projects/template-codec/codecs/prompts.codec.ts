/**
 * Prompts codec — owns the `prompts` template section (export build + import apply),
 * including prompt tags.
 *
 * Replace-mode apply preserves the legacy `createImportedPrompts` semantics exactly:
 * create each prompt (with tags) and record `promptIdMap` (old id -> new id) plus
 * `createdPrompts` ({id,title}) for downstream initial-prompt resolution.
 */
import type { ImportContext } from '../import-context';
import {
  PROMPT_TRANSFER_POLICY,
  partitionPromptsForTransfer,
} from '../../../../common/prompt-transfer';
import {
  canonicalizePromptTypeTags,
  getPromptType,
  PROMPT_TYPE,
} from '../../../../common/prompt-type';
import type {
  CodecApplyResult,
  CodecApplyRuntime,
  ExportBuildContext,
  ParsedTemplatePayload,
  PipelineMode,
  TemplateSectionCodec,
} from '../template-section-codec';

type PromptsSection = ParsedTemplatePayload['prompts'];

/** Export builder (moved verbatim from project-export.ts `loadExportPrompts`). */
export async function loadExportPrompts(
  promptsRes: ExportBuildContext['promptsRes'],
  storage: ExportBuildContext['storage'],
): Promise<Array<{ id: string; title: string; content: string; version: number; tags: string[] }>> {
  const fullPrompts = await Promise.all(
    promptsRes.items.map((prompt) => storage.getPrompt(prompt.id)),
  );

  return fullPrompts.map((prompt) => ({
    id: prompt.id,
    title: prompt.title,
    content: prompt.content,
    version: prompt.version,
    tags: prompt.tags,
  }));
}

class PromptsCodec implements TemplateSectionCodec<PromptsSection> {
  readonly declaration = {
    section: 'prompts',
    reads: [],
    writes: ['promptIdMap', 'createdPrompts'],
    requiresState: ['existingDataCleared'],
    producesState: ['promptsPersisted'],
    modes: ['replace', 'create'],
  } as const;

  pick(payload: ParsedTemplatePayload): PromptsSection {
    return payload.prompts;
  }

  build(ctx: ExportBuildContext) {
    return loadExportPrompts(ctx.promptsRes, ctx.storage);
  }

  async apply(
    prompts: PromptsSection,
    ctx: ImportContext,
    _mode: PipelineMode,
    rt: CodecApplyRuntime,
  ): Promise<CodecApplyResult> {
    const { projectId, storage } = rt;
    const policy = rt.promptTransferPolicy ?? PROMPT_TRANSFER_POLICY.Template;
    const partition = partitionPromptsForTransfer(prompts, policy);
    const createPrompt =
      policy === PROMPT_TRANSFER_POLICY.Snapshot
        ? rt.snapshotPromptWriter?.createPromptFromSnapshot.bind(rt.snapshotPromptWriter)
        : storage.createPrompt.bind(storage);
    if (!createPrompt) {
      throw new Error('Snapshot prompt writer is unavailable');
    }
    const promptIdMap: Record<string, string> = {};
    const createdPrompts: Array<{ id: string; title: string }> = [];

    for (const prompt of partition.transfer) {
      const created = await createPrompt({
        projectId,
        title: prompt.title,
        content: prompt.content,
        tags:
          policy === PROMPT_TRANSFER_POLICY.Template
            ? canonicalizePromptTypeTags(
                prompt.tags ?? [],
                getPromptType(prompt.tags ?? [], PROMPT_TYPE.System),
              )
            : (prompt.tags ?? []),
      });

      if (prompt.id) promptIdMap[prompt.id] = created.id;
      createdPrompts.push({ id: created.id, title: created.title });
    }

    ctx.set('promptIdMap', promptIdMap);
    ctx.set('createdPrompts', createdPrompts);

    return {
      section: 'prompts',
      log: { created: createdPrompts.length },
      promptTransfer: {
        imported: createdPrompts.length,
        skipped: partition.retain.length,
      },
    };
  }
}

export const promptsCodec = new PromptsCodec();
