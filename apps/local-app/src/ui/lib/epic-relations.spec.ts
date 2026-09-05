import {
  EpicRelationConfirmationError,
  RELATION_ROUTE_HISTORY_WARNING,
  isEpicRelationConfirmationError,
  relatedEpicRole,
  relationRouteBoundaryWarning,
  relationRouteChangeKind,
  relationRouteChangeWarning,
} from '@/ui/lib/epic-relations';

// Layer: pure unit. Warning derivation and the typed 409 contract are
// deterministic over facts and endpoint titles.
describe('epic-relations route warnings', () => {
  const endpoints = [
    { id: 'epic-a', title: 'Alpha' },
    { id: 'epic-b', title: 'Beta' },
    { id: 'epic-c', title: 'Gamma' },
  ];

  it('names the target as the logging anchor with source and target semantics', () => {
    // Source epic-a contributes time; target epic-c includes and logs it, so
    // the target is named first.
    const lines = relationRouteChangeWarning(
      'flip',
      { sourceEpicId: 'epic-a', targetEpicId: 'epic-c' },
      endpoints,
    );
    expect(lines[0]).toBe('Current route: “Gamma” logs time with “Alpha”.');
  });

  it('states that a replacement removes the old Related pair', () => {
    const lines = relationRouteChangeWarning(
      'replace',
      { sourceEpicId: 'epic-a', targetEpicId: 'epic-c' },
      endpoints,
    );
    expect(lines[1]).toBe(
      'Saving removes the old Related pair — its target stops including that source’s time.',
    );
  });

  it('returns no boundary warning without linked endpoints', () => {
    expect(relationRouteBoundaryWarning([])).toEqual([]);
  });

  it('classifies a 409 by comparing the server facts with the edited pair', () => {
    const ownPair = ['epic-a', 'epic-b'] as const;
    expect(
      relationRouteChangeKind(
        { type: 'related' },
        { sourceEpicId: 'epic-b', targetEpicId: 'epic-a' },
        ownPair,
      ),
    ).toBe('flip');
    expect(
      relationRouteChangeKind(
        { type: 'related' },
        { sourceEpicId: 'epic-a', targetEpicId: 'epic-c' },
        ownPair,
      ),
    ).toBe('replace');
    expect(
      relationRouteChangeKind(
        { type: 'blocks' },
        { sourceEpicId: 'epic-a', targetEpicId: 'epic-b' },
        ownPair,
      ),
    ).toBe('blocks');
  });

  it.each(['replace', 'flip', 'blocks', 'delete'] as const)(
    'warns for %s with the server facts and the history sentence',
    (kind) => {
      const lines = relationRouteChangeWarning(
        kind,
        { sourceEpicId: 'epic-a', targetEpicId: 'epic-c' },
        endpoints,
      );
      expect(lines[0]).toBe('Current route: “Gamma” logs time with “Alpha”.');
      expect(lines[1].length).toBeGreaterThan(0);
      expect(lines).toContain(RELATION_ROUTE_HISTORY_WARNING);
    },
  );

  it('falls back to the short Epic ID for a fact outside the dialog endpoints', () => {
    const lines = relationRouteChangeWarning(
      'replace',
      { sourceEpicId: 'epic-a', targetEpicId: 'unknown-epic-id' },
      endpoints,
    );
    expect(lines[0]).toBe('Current route: Epic unknown- logs time with “Alpha”.');
  });

  it('names linked endpoints in the boundary warning with the history sentence', () => {
    const lines = relationRouteBoundaryWarning([{ id: 'epic-b', title: 'Beta' }]);
    expect(lines[0]).toContain('“Beta” is linked to an external task');
    expect(lines).toContain(RELATION_ROUTE_HISTORY_WARNING);
  });

  it('identifies the typed 409 error', () => {
    const effect = { sourceEpicId: 'epic-a', targetEpicId: 'epic-b' };
    const error = new EpicRelationConfirmationError('Confirm the route.', effect);
    expect(isEpicRelationConfirmationError(error)).toBe(true);
    expect(error.currentEffect).toEqual(effect);
    expect(isEpicRelationConfirmationError(new Error('Confirm the route.'))).toBe(false);
  });
});

// Layer: pure unit. The focal-relative role derivation is shared by the Epic
// detail card and the Board relation preview and must read the same from
// either side of one stored pair.
describe('relatedEpicRole', () => {
  const relatedEpic = { id: 'epic-b' };

  it('marks the counterpart as Source when it is the stored source', () => {
    expect(relatedEpicRole({ sourceEpicId: 'epic-b', relatedEpic })).toBe('Source');
  });

  it('marks the counterpart as Target when the focal Epic is the stored source', () => {
    expect(relatedEpicRole({ sourceEpicId: 'epic-a', relatedEpic })).toBe('Target');
  });

  it('returns null for a legacy neutral pair with no stored direction', () => {
    expect(relatedEpicRole({ sourceEpicId: null, relatedEpic })).toBeNull();
  });
});
