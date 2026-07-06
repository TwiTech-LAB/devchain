import { ImportContext, ImportContextError } from './import-context';

describe('ImportContext', () => {
  it('returns a value that was written', () => {
    const ctx = new ImportContext();
    ctx.set('promptIdMap', { a: 'b' });
    expect(ctx.get('promptIdMap')).toEqual({ a: 'b' });
    expect(ctx.has('promptIdMap')).toBe(true);
  });

  it('throws read-before-write when reading an unset key', () => {
    const ctx = new ImportContext();
    expect(ctx.has('statusIdMap')).toBe(false);
    expect(() => ctx.get('statusIdMap')).toThrow(ImportContextError);
    expect(() => ctx.get('statusIdMap')).toThrow(/read-before-write/);
  });

  it('seeds keys/states via the constructor and honors them', () => {
    const ctx = new ImportContext({ agentIdMap: { old: 'new' } }, ['existingDataCleared']);
    expect(ctx.get('agentIdMap')).toEqual({ old: 'new' });
    expect(ctx.hasState('existingDataCleared')).toBe(true);
    ctx.requireState('existingDataCleared'); // no throw
  });

  it('ignores undefined seed values (still read-before-write)', () => {
    const ctx = new ImportContext({ agentIdMap: undefined });
    expect(ctx.has('agentIdMap')).toBe(false);
    expect(() => ctx.get('agentIdMap')).toThrow(ImportContextError);
  });

  it('throws when requiring a storage state that was not marked', () => {
    const ctx = new ImportContext();
    expect(() => ctx.requireState('agentsPersisted')).toThrow(ImportContextError);
    ctx.markState('agentsPersisted');
    expect(() => ctx.requireState('agentsPersisted')).not.toThrow();
  });
});
