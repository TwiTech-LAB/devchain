import { removeGitShimFromPath } from './git-shim-paths';

describe('removeGitShimFromPath', () => {
  it('drops every entry naming the shim directory and keeps the others in order', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/shim/bin/:/usr/bin:/shim/./bin:/bin:/usr/local/bin' };

    removeGitShimFromPath(env, '/shim/bin');

    expect(env.PATH).toBe('/usr/bin:/bin:/usr/local/bin');
  });

  it('leaves an unset PATH unset', () => {
    const env: NodeJS.ProcessEnv = {};

    removeGitShimFromPath(env, '/shim/bin');

    expect(env.PATH).toBeUndefined();
  });
});
