import { teamsQueryKeys } from './teams';

describe('teamsQueryKeys', () => {
  it('builds the list key with the project id', () => {
    expect(teamsQueryKeys.teams('project-1')).toEqual(['teams', 'project-1']);
  });

  it('builds the detail key with the team id', () => {
    expect(teamsQueryKeys.detail('team-1')).toEqual(['teams', 'detail', 'team-1']);
  });
});
