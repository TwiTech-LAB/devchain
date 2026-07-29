import {
  buildPromptReferenceValidationFailure,
  extractPromptReferenceTitles,
  findSkippedTemplatePromptReferences,
  rankPromptCandidatesSystemFirst,
} from './prompt-references';

describe('prompt references', () => {
  it('extracts only executable prompt references using resolver-compatible grammar', () => {
    expect(
      extractPromptReferenceTitles(
        '[[prompt: Shared SOP ]] [[Prompt:Wrong Case]] [[#tag]] [[document]] [[prompt:]]',
      ),
    ).toEqual(['Shared SOP']);
  });

  it('does not report Custom prompt references because Template transfers every prompt', () => {
    const issues = findSkippedTemplatePromptReferences(
      [
        { name: 'Coder', instructions: 'Use [[prompt:Private SOP]].' },
        { name: 'Reviewer', instructions: 'Also use [[prompt:private sop]].' },
      ],
      [{ title: 'Private SOP', tags: ['type:custom'] }],
    );

    expect(issues).toEqual([]);
    expect(buildPromptReferenceValidationFailure(issues)).toBeNull();
  });

  it('builds a structured failure for a policy-provided skipped reference', () => {
    expect(
      buildPromptReferenceValidationFailure([
        {
          promptTitle: 'Private SOP',
          profileNames: ['Coder', 'Reviewer'],
        },
      ]),
    ).toMatchObject({
      success: false,
      mutationStarted: false,
      promptReferenceValidation: {
        code: 'skipped_prompt_references',
        promptTitles: ['Private SOP'],
      },
    });
  });

  it('accepts a matching transferred System prompt and ignores absent references', () => {
    expect(
      findSkippedTemplatePromptReferences(
        [{ name: 'Coder', instructions: '[[prompt:Shared]] [[prompt:Not Packaged]]' }],
        [
          { title: 'Shared', tags: ['type:custom'] },
          { title: 'SHARED', tags: ['type:system'] },
        ],
      ),
    ).toEqual([]);
  });

  it('does not treat a whitespace-different prompt title as an executable match', () => {
    expect(
      findSkippedTemplatePromptReferences(
        [{ name: 'Coder', instructions: '[[prompt:Private SOP]]' }],
        [{ title: ' Private SOP ', tags: ['type:custom'] }],
      ),
    ).toEqual([]);
  });

  it('ranks System and legacy-untyped candidates first without reordering peers', () => {
    const candidates = [
      { id: 'custom-a', tags: ['type:custom'] },
      { id: 'system-a', tags: ['type:system'] },
      { id: 'legacy', tags: ['scope:legacy'] },
      { id: 'custom-b', tags: ['type:custom'] },
      { id: 'system-b', tags: ['type:system'] },
    ];

    expect(rankPromptCandidatesSystemFirst(candidates).map((candidate) => candidate.id)).toEqual([
      'system-a',
      'legacy',
      'system-b',
      'custom-a',
      'custom-b',
    ]);
    expect(candidates.map((candidate) => candidate.id)).toEqual([
      'custom-a',
      'system-a',
      'legacy',
      'custom-b',
      'system-b',
    ]);
  });
});
