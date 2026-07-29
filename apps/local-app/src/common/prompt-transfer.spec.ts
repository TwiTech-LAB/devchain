import {
  PROMPT_TRANSFER_POLICY,
  partitionPromptsForTransfer,
  planPromptReplacement,
} from './prompt-transfer';

type TestPrompt = {
  id: string;
  title: string;
  tags?: string[];
};

const prompt = (id: string, title: string, tags?: string[]): TestPrompt => ({
  id,
  title,
  tags,
});

describe('prompt transfer', () => {
  it('transfers every incoming prompt under both policies', () => {
    const prompts = [
      prompt('system', 'System', ['type:system']),
      prompt('untyped', 'Untyped'),
      prompt('custom', 'Custom', ['type:custom']),
    ];

    expect(partitionPromptsForTransfer(prompts, PROMPT_TRANSFER_POLICY.Template)).toEqual({
      transfer: prompts,
      retain: [],
    });
    expect(partitionPromptsForTransfer(prompts, PROMPT_TRANSFER_POLICY.Snapshot)).toEqual({
      transfer: prompts,
      retain: [],
    });
  });

  it('deletes replace-owned rows and matching Custom titles without trimming', () => {
    const incoming = [
      prompt('incoming-system', 'Local Guide', ['type:system']),
      prompt('incoming-custom-1', 'Shared Guide', ['type:custom']),
      prompt('incoming-custom-2', 'SHARED GUIDE', ['type:custom']),
      prompt('incoming-spaced', ' Spaced Guide ', ['type:custom']),
    ];
    const existing = [
      prompt('system', 'System', ['type:system']),
      prompt('untyped', 'Untyped'),
      prompt('matching-custom-1', 'shared guide', ['type:custom']),
      prompt('matching-custom-2', 'Shared Guide', ['type:future']),
      prompt('matching-spaced', ' spaced guide ', ['type:custom']),
      prompt('whitespace-different', 'Spaced Guide', ['type:custom']),
      prompt('system-title-only', 'Local Guide', ['type:custom']),
      prompt('unmatched-custom', 'Local Only', ['type:custom']),
    ];

    expect(planPromptReplacement(incoming, existing, PROMPT_TRANSFER_POLICY.Template)).toEqual({
      deleteIds: ['system', 'untyped', 'matching-custom-1', 'matching-custom-2', 'matching-spaced'],
      preserveIds: ['whitespace-different', 'system-title-only', 'unmatched-custom'],
    });
  });

  it('deletes all existing rows for Snapshot recovery', () => {
    const existing = [
      prompt('system', 'System', ['type:system']),
      prompt('custom', 'Custom', ['type:custom']),
    ];

    expect(planPromptReplacement([], existing, PROMPT_TRANSFER_POLICY.Snapshot)).toEqual({
      deleteIds: ['system', 'custom'],
      preserveIds: [],
    });
  });
});
