import { projectsQueryKeys } from './project-query-keys';

describe('projectsQueryKeys', () => {
  it('preserves the project management and workflow tuple identities', () => {
    const request = { slug: 'demo', version: '1.0.0' };

    expect(projectsQueryKeys.all()).toEqual(['projects']);
    expect(projectsQueryKeys.list()).toEqual(['projects', 'manage']);
    expect(projectsQueryKeys.templatesForCreate()).toEqual(['project-templates']);
    expect(projectsQueryKeys.templatesForUpgrade()).toEqual(['templates-for-upgrade']);
    expect(projectsQueryKeys.manifest('project-1')).toEqual(['template-manifest', 'project-1']);
    expect(projectsQueryKeys.setupPreview(request)).toEqual(['setup-preview', request]);
    expect(projectsQueryKeys.upgradePreview('project-1', '2.0.0', 'remote-1')).toEqual([
      'upgrade-template-preview',
      'project-1',
      '2.0.0',
      'remote-1',
    ]);
  });

  it('keeps workspace availability and selector details distinct from ProvidersPage', () => {
    const providersPageAllKey = ['projects', 'all'];

    expect(projectsQueryKeys.available('workspace-1')).toEqual([
      'projects',
      'available',
      'workspace-1',
    ]);
    expect(projectsQueryKeys.detail({ id: 'project-1' })).toEqual([
      'projects',
      'detail',
      { id: 'project-1' },
    ]);
    expect(projectsQueryKeys.detail({ path: '/workspace/project-1' })).toEqual([
      'projects',
      'detail',
      { path: '/workspace/project-1' },
    ]);
    expect(projectsQueryKeys.all()).not.toEqual(providersPageAllKey);
    expect(projectsQueryKeys.list()).not.toEqual(providersPageAllKey);
    expect(projectsQueryKeys.available('workspace-1')).not.toEqual(providersPageAllKey);
    expect(projectsQueryKeys.detail({ id: 'project-1' })).not.toEqual(providersPageAllKey);
  });
});
