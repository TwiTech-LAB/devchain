import {
  ensureNoDuplicateAgentNames,
  planAndApplySessionPreservation,
} from './project-import-sessions';
import { ValidationError } from '../../../common/errors/error-types';

describe('ensureNoDuplicateAgentNames', () => {
  it('passes for unique names', () => {
    expect(() => ensureNoDuplicateAgentNames([{ name: 'Alpha' }, { name: 'Beta' }])).not.toThrow();
  });

  it('throws ValidationError on whitespace-trimmed duplicates', () => {
    expect(() => ensureNoDuplicateAgentNames([{ name: '  Alpha  ' }, { name: 'alpha' }])).toThrow(
      ValidationError,
    );
  });

  it('includes duplicate names in the error payload', () => {
    try {
      ensureNoDuplicateAgentNames([{ name: 'Alpha' }, { name: 'alpha' }, { name: 'Beta' }]);
      fail('Expected ValidationError');
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).details).toEqual(
        expect.objectContaining({
          duplicates: ['alpha'],
          hint: expect.stringContaining('unique'),
        }),
      );
    }
  });
});

describe('planAndApplySessionPreservation', () => {
  const mockStorage = {
    applySessionPlan: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('preserves sessions when old agent name matches new template', async () => {
    const parked = new Map([['old-agent-1', ['sess-1', 'sess-2']]]);
    const oldAgents = [{ id: 'old-agent-1', name: 'Coder' }];
    const newNameToId = { coder: 'new-agent-1' };

    const result = await planAndApplySessionPreservation(
      parked,
      oldAgents,
      newNameToId,
      mockStorage,
    );

    expect(result).toEqual({ preservedCount: 2, removedCount: 0 });
    expect(mockStorage.applySessionPlan).toHaveBeenCalledWith(
      [
        { sessionId: 'sess-1', newAgentId: 'new-agent-1' },
        { sessionId: 'sess-2', newAgentId: 'new-agent-1' },
      ],
      [],
    );
  });

  it('deletes sessions when old agent name has no match in new template', async () => {
    const parked = new Map([['old-agent-1', ['sess-1']]]);
    const oldAgents = [{ id: 'old-agent-1', name: 'RemovedAgent' }];
    const newNameToId = { coder: 'new-agent-1' };

    const result = await planAndApplySessionPreservation(
      parked,
      oldAgents,
      newNameToId,
      mockStorage,
    );

    expect(result).toEqual({ preservedCount: 0, removedCount: 1 });
    expect(mockStorage.applySessionPlan).toHaveBeenCalledWith([], ['sess-1']);
  });

  it('handles mix of preserved and removed sessions across multiple agents', async () => {
    const parked = new Map([
      ['old-a1', ['sess-1', 'sess-2']],
      ['old-a2', ['sess-3']],
      ['old-a3', ['sess-4']],
    ]);
    const oldAgents = [
      { id: 'old-a1', name: 'Coder' },
      { id: 'old-a2', name: 'Reviewer' },
      { id: 'old-a3', name: 'Deleted' },
    ];
    const newNameToId = { coder: 'new-a1', reviewer: 'new-a2' };

    const result = await planAndApplySessionPreservation(
      parked,
      oldAgents,
      newNameToId,
      mockStorage,
    );

    expect(result).toEqual({ preservedCount: 3, removedCount: 1 });
  });

  it('returns zero counts and calls applySessionPlan with empty arrays when parked map is empty', async () => {
    const result = await planAndApplySessionPreservation(
      new Map(),
      [{ id: 'a1', name: 'X' }],
      { x: 'new-a1' },
      mockStorage,
    );

    expect(result).toEqual({ preservedCount: 0, removedCount: 0 });
    expect(mockStorage.applySessionPlan).toHaveBeenCalledWith([], []);
  });

  it('treats parked sessions from unknown old agents as deletes (defensive)', async () => {
    const parked = new Map([['unknown-agent', ['sess-orphan']]]);
    const oldAgents: Array<{ id: string; name: string }> = [];
    const newNameToId = {};

    const result = await planAndApplySessionPreservation(
      parked,
      oldAgents,
      newNameToId,
      mockStorage,
    );

    expect(result).toEqual({ preservedCount: 0, removedCount: 1 });
    expect(mockStorage.applySessionPlan).toHaveBeenCalledWith([], ['sess-orphan']);
  });

  it('matches agent names case-insensitively with trimming', async () => {
    const parked = new Map([['old-a1', ['sess-1']]]);
    const oldAgents = [{ id: 'old-a1', name: '  Coder  ' }];
    const newNameToId = { coder: 'new-a1' };

    const result = await planAndApplySessionPreservation(
      parked,
      oldAgents,
      newNameToId,
      mockStorage,
    );

    expect(result).toEqual({ preservedCount: 1, removedCount: 0 });
  });
});
