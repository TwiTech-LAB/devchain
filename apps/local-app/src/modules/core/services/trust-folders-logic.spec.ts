import { getEffectiveTrust } from './trust-folders-logic';

describe('getEffectiveTrust', () => {
  it('returns no_rule when no rules exist', () => {
    expect(getEffectiveTrust('/repos/foo', {})).toEqual({ kind: 'no_rule' });
  });

  it('exact TRUST_FOLDER → trusted exact', () => {
    expect(getEffectiveTrust('/repos/foo', { '/repos/foo': 'TRUST_FOLDER' })).toEqual({
      kind: 'trusted',
      via: 'exact',
    });
  });

  it('ancestor TRUST_FOLDER covers descendant', () => {
    expect(getEffectiveTrust('/repos/foo', { '/repos': 'TRUST_FOLDER' })).toEqual({
      kind: 'trusted',
      via: 'ancestor',
    });
  });

  it('TRUST_PARENT for same path → trusted via parent_rule (effective = dirname)', () => {
    expect(getEffectiveTrust('/repos/foo', { '/repos/foo': 'TRUST_PARENT' })).toEqual({
      kind: 'trusted',
      via: 'parent_rule',
    });
  });

  it('ancestor TRUST_PARENT (rule /repos, project /repos/foo) → trusted via parent_rule', () => {
    expect(getEffectiveTrust('/repos/foo', { '/repos': 'TRUST_PARENT' })).toEqual({
      kind: 'trusted',
      via: 'parent_rule',
    });
  });

  it('sibling via TRUST_PARENT (rule /repos/bar, project /repos/foo) → trusted via parent_rule', () => {
    expect(getEffectiveTrust('/repos/foo', { '/repos/bar': 'TRUST_PARENT' })).toEqual({
      kind: 'trusted',
      via: 'parent_rule',
    });
  });

  it('exact DO_NOT_TRUST → distrusted exact', () => {
    expect(getEffectiveTrust('/repos/foo', { '/repos/foo': 'DO_NOT_TRUST' })).toEqual({
      kind: 'distrusted',
      via: 'exact',
    });
  });

  it('ancestor DO_NOT_TRUST → distrusted ancestor', () => {
    expect(getEffectiveTrust('/repos/foo', { '/repos': 'DO_NOT_TRUST' })).toEqual({
      kind: 'distrusted',
      via: 'ancestor',
    });
  });

  it('longest match wins (more specific rule prevails)', () => {
    expect(
      getEffectiveTrust('/repos/foo/bar', {
        '/repos': 'DO_NOT_TRUST',
        '/repos/foo': 'TRUST_FOLDER',
      }),
    ).toEqual({ kind: 'trusted', via: 'ancestor' });
  });

  it('non-matching rules ignored', () => {
    expect(getEffectiveTrust('/other/project', { '/repos': 'TRUST_FOLDER' })).toEqual({
      kind: 'no_rule',
    });
  });

  it('partial path match does not count (rule /repos/foobar, project /repos/foo)', () => {
    expect(getEffectiveTrust('/repos/foo', { '/repos/foobar': 'TRUST_FOLDER' })).toEqual({
      kind: 'no_rule',
    });
  });
});
