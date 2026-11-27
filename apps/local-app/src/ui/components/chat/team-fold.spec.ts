import { TEAM_FOLD_OVERRIDES_KEY, loadTeamFoldOverrides, saveTeamFoldOverride } from './team-fold';

describe('team fold persistence', () => {
  afterEach(() => window.localStorage.removeItem(TEAM_FOLD_OVERRIDES_KEY));

  it('reads corrupt stored JSON as an empty map and replaces it on the next write', () => {
    window.localStorage.setItem(TEAM_FOLD_OVERRIDES_KEY, '{not json');
    expect(loadTeamFoldOverrides()).toEqual({});

    expect(() =>
      saveTeamFoldOverride('team-1', { collapsed: true, whenActive: true }),
    ).not.toThrow();
    expect(JSON.parse(window.localStorage.getItem(TEAM_FOLD_OVERRIDES_KEY)!)).toEqual({
      'team-1': { collapsed: true, whenActive: true },
    });
  });
});
