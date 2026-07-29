import { PROMPT_TRANSFER_POLICY } from '../../../../common/prompt-transfer';
import { ImportContext } from '../import-context';
import type { CodecApplyRuntime } from '../template-section-codec';
import { promptsCodec } from './prompts.codec';

const TEMPLATE_PROMPTS = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Explicit System',
    content: 'system',
    version: 1,
    tags: ['scope:shared', 'type:system'],
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    title: 'Legacy Untyped',
    content: 'legacy',
    version: 1,
    tags: ['scope:legacy'],
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    title: 'Custom',
    content: 'custom',
    version: 1,
    tags: ['type:custom'],
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    title: 'Future Typed',
    content: 'future',
    version: 1,
    tags: ['type:future'],
  },
];

function makeRuntime(policy: CodecApplyRuntime['promptTransferPolicy']) {
  const createPrompt = jest.fn().mockImplementation(async (data: { title: string }) => ({
    id: `created-${data.title}`,
    ...data,
  }));
  const createPromptFromSnapshot = jest
    .fn()
    .mockImplementation(async (data: { title: string }) => ({
      id: `restored-${data.title}`,
      ...data,
    }));

  return {
    createPrompt,
    createPromptFromSnapshot,
    runtime: {
      projectId: 'project-1',
      promptTransferPolicy: policy,
      storage: { createPrompt },
      snapshotPromptWriter: { createPromptFromSnapshot },
    } as unknown as CodecApplyRuntime,
  };
}

describe('prompts codec transfer policy', () => {
  it('imports every prompt with its parsed type and System fallback in template mode', async () => {
    const { createPrompt, createPromptFromSnapshot, runtime } = makeRuntime(
      PROMPT_TRANSFER_POLICY.Template,
    );
    const context = new ImportContext();

    const result = await promptsCodec.apply(TEMPLATE_PROMPTS, context, 'replace', runtime);

    expect(createPrompt).toHaveBeenCalledTimes(4);
    expect(createPromptFromSnapshot).not.toHaveBeenCalled();
    expect(createPrompt).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ tags: ['scope:shared', 'type:system'] }),
    );
    expect(createPrompt).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ tags: ['scope:legacy', 'type:system'] }),
    );
    expect(createPrompt).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ tags: ['type:custom'] }),
    );
    expect(createPrompt).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ tags: ['type:custom'] }),
    );
    expect(result.promptTransfer).toEqual({ imported: 4, skipped: 0 });
    expect(context.get('promptIdMap')).toEqual({
      '11111111-1111-4111-8111-111111111111': 'created-Explicit System',
      '22222222-2222-4222-8222-222222222222': 'created-Legacy Untyped',
      '33333333-3333-4333-8333-333333333333': 'created-Custom',
      '44444444-4444-4444-8444-444444444444': 'created-Future Typed',
    });
    expect(context.get('createdPrompts')).toEqual([
      { id: 'created-Explicit System', title: 'Explicit System' },
      { id: 'created-Legacy Untyped', title: 'Legacy Untyped' },
      { id: 'created-Custom', title: 'Custom' },
      { id: 'created-Future Typed', title: 'Future Typed' },
    ]);
  });

  it('preserves exact tags through the Snapshot-only writer while importing all prompts', async () => {
    const { createPrompt, createPromptFromSnapshot, runtime } = makeRuntime(
      PROMPT_TRANSFER_POLICY.Snapshot,
    );
    const context = new ImportContext();
    const prompts = [
      ...TEMPLATE_PROMPTS,
      {
        id: '55555555-5555-4555-8555-555555555555',
        title: 'Exact Tags',
        content: 'exact',
        version: 1,
        tags: ['scope:first', 'type:future', 'TYPE:System', 'type:custom', 'scope:last'],
      },
    ];

    const result = await promptsCodec.apply(prompts, context, 'replace', runtime);

    expect(createPrompt).not.toHaveBeenCalled();
    expect(createPromptFromSnapshot).toHaveBeenCalledTimes(5);
    expect(createPromptFromSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ tags: prompts[4].tags }),
    );
    expect(result.promptTransfer).toEqual({ imported: 5, skipped: 0 });
    expect(Object.keys(context.get('promptIdMap'))).toHaveLength(5);
    expect(context.get('createdPrompts')).toHaveLength(5);
  });

  it('fails closed when Snapshot restore lacks its trusted writer capability', async () => {
    const { runtime } = makeRuntime(PROMPT_TRANSFER_POLICY.Snapshot);
    const context = new ImportContext();
    delete (runtime as { snapshotPromptWriter?: unknown }).snapshotPromptWriter;

    await expect(promptsCodec.apply(TEMPLATE_PROMPTS, context, 'replace', runtime)).rejects.toThrow(
      'Snapshot prompt writer is unavailable',
    );
  });
});
