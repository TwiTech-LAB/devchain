import { getEffectiveTrust } from './trust-folders-logic';

describe('getEffectiveTrust', () => {
  it('returns no_rule when no rules exist', () => {
    expect(getEffectiveTrust('/repos/foo', {})).toEqual({ kind: 'no_rule' });
  });

  it.each([
    {
      name: 'exact TRUST_FOLDER → trusted exact',
      project: '/repos/foo',
      rules: { '/repos/foo': 'TRUST_FOLDER' } as Parameters<typeof getEffectiveTrust>[1],
      expected: {
        kind: 'trusted',
        via: 'exact',
      },
    },
    {
      name: 'ancestor TRUST_FOLDER covers descendant',
      project: '/repos/foo',
      rules: { '/repos': 'TRUST_FOLDER' } as Parameters<typeof getEffectiveTrust>[1],
      expected: {
        kind: 'trusted',
        via: 'ancestor',
      },
    },
    {
      name: 'TRUST_PARENT for same path → trusted via parent_rule (effective = dirname)',
      project: '/repos/foo',
      rules: { '/repos/foo': 'TRUST_PARENT' } as Parameters<typeof getEffectiveTrust>[1],
      expected: {
        kind: 'trusted',
        via: 'parent_rule',
      },
    },
    {
      name: 'ancestor TRUST_PARENT (rule /repos, project /repos/foo) → trusted via parent_rule',
      project: '/repos/foo',
      rules: { '/repos': 'TRUST_PARENT' } as Parameters<typeof getEffectiveTrust>[1],
      expected: {
        kind: 'trusted',
        via: 'parent_rule',
      },
    },
    {
      name: 'sibling via TRUST_PARENT (rule /repos/bar, project /repos/foo) → trusted via parent_rule',
      project: '/repos/foo',
      rules: { '/repos/bar': 'TRUST_PARENT' } as Parameters<typeof getEffectiveTrust>[1],
      expected: {
        kind: 'trusted',
        via: 'parent_rule',
      },
    },
    {
      name: 'exact DO_NOT_TRUST → distrusted exact',
      project: '/repos/foo',
      rules: { '/repos/foo': 'DO_NOT_TRUST' } as Parameters<typeof getEffectiveTrust>[1],
      expected: {
        kind: 'distrusted',
        via: 'exact',
      },
    },
    {
      name: 'ancestor DO_NOT_TRUST → distrusted ancestor',
      project: '/repos/foo',
      rules: { '/repos': 'DO_NOT_TRUST' } as Parameters<typeof getEffectiveTrust>[1],
      expected: {
        kind: 'distrusted',
        via: 'ancestor',
      },
    },
  ])('$name', ({ project, rules, expected }) => {
    expect(getEffectiveTrust(project, rules)).toEqual(expected);
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
