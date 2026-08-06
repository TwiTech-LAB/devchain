import { getContainerScopedProjectId } from './container-scope';

describe('getContainerScopedProjectId', () => {
  const projectId = '11111111-1111-4111-8111-111111111111';

  it('returns the configured project only in normal mode', () => {
    expect(
      getContainerScopedProjectId({
        DEVCHAIN_MODE: 'normal',
        CONTAINER_PROJECT_ID: projectId,
      }),
    ).toBe(projectId);
  });

  it('returns null when normal mode has no container project', () => {
    expect(
      getContainerScopedProjectId({
        DEVCHAIN_MODE: 'normal',
        CONTAINER_PROJECT_ID: undefined,
      }),
    ).toBeNull();
  });

  it('ignores a container project in main mode', () => {
    expect(
      getContainerScopedProjectId({
        DEVCHAIN_MODE: 'main',
        CONTAINER_PROJECT_ID: projectId,
      }),
    ).toBeNull();
  });
});
