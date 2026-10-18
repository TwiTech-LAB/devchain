import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChildProcessExecutor } from '../../terminal/services/process-executor/child-process-executor';
import { GitShimRegistryService } from './git-shim-registry.service';

describe('GitShimRegistryService', () => {
  const originalPath = process.env.PATH;
  let directory: string;
  let home: string;
  let roots: Record<string, string>;
  let version: string;
  let gitProjects: string[];

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'git-shim-registry-')));
    home = join(directory, 'shim');
    roots = {};
    for (const [id, name] of [
      ['home-p', "it's home"],
      ['vm-p', 'vm'],
      ['no-git', 'none'],
    ]) {
      roots[id] = join(directory, name);
      await mkdir(id === 'no-git' ? roots[id] : join(roots[id], '.git'), { recursive: true });
    }
    version = 'git version 2.43.0\n';
    gitProjects = ['home-p', 'vm-p', 'no-git'];
  });
  afterEach(async () => {
    process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  });

  function registry(executor: unknown = { run: async () => ({ stdout: version }) }, onVm = true) {
    const storage = {
      listRemoteProjectBindings: async () => [{ projectId: 'home-p', remoteId: 'r1' }],
      getProject: async (id: string) => ({ rootPath: roots[id] }),
      getRemote: async () => ({ name: "vm '01'" }),
    };
    return new GitShimRegistryService(
      storage as never,
      { projectsWithFolder: async () => gitProjects } as never,
      { get: () => 'vm', generation: () => 3 } as never,
      { read: () => ({ owner: 'home', generation: 7, homeName: 'laptop' }) } as never,
      executor as never,
      home,
      0,
      () => onVm,
    );
  }

  /** What the shim's `case` sets for a Git common dir. */
  function lookup(common: string): string {
    return execFileSync(
      'sh',
      [
        '-c',
        '. "$1/projects.sh"; printf "%s|%s|%s|%s" "$devchain_project" "$devchain_side" "$devchain_remote" "$devchain_state"',
        'sh',
        home,
      ],
      { env: { PATH: process.env.PATH, devchain_common: common }, encoding: 'utf8' },
    );
  }

  it("lists each connected project's Git common dir with its side and owner state", async () => {
    await registry().refresh();

    const state = (id: string) => join(home, 'state', id);
    expect(lookup(join(roots['home-p'], '.git'))).toBe(`home-p|home|vm '01'|${state('home-p')}`);
    expect(lookup(join(roots['vm-p'], '.git'))).toBe(`vm-p|vm|laptop|${state('vm-p')}`);
    expect(lookup(join(directory, 'other', '.git'))).toBe('|||');
    expect(await readFile(state('home-p'), 'utf8')).toBe('vm 3\n');
    expect(await readFile(state('vm-p'), 'utf8')).toBe('home 7\n');
    expect((await readdir(join(home, 'state'))).sort()).toEqual(['home-p', 'vm-p']);
  });

  // Disconnect keeps the sync folders, and the shim takes the first entry for a common dir.
  it('lists on the PC only projects bound to a VM, even when another project shares the folder', async () => {
    roots['a-disconnected'] = roots['home-p'];
    gitProjects = ['a-disconnected', 'home-p', 'vm-p'];

    await registry(undefined, false).refresh();

    expect(lookup(join(roots['home-p'], '.git'))).toBe(
      `home-p|home|vm '01'|${join(home, 'state', 'home-p')}`,
    );
    expect(lookup(join(roots['vm-p'], '.git'))).toBe('|||');
    expect(await readdir(join(home, 'state'))).toEqual(['home-p']);
  });

  it('drops the state of a project that is no longer connected', async () => {
    await registry().refresh();
    gitProjects = ['vm-p'];
    await writeFile(join(home, 'state', 'stray'), 'vm 1\n');

    await registry().refresh();

    expect(lookup(join(roots['home-p'], '.git'))).toBe('|||');
    expect(await readdir(join(home, 'state'))).toEqual(['vm-p']);
  });

  // The executor replaces the environment; without PATH, Node looks only in /usr/bin:/bin and
  // misses the git the user runs (a source build in /usr/local/bin, Homebrew).
  it('checks the version of the git found on PATH', async () => {
    const bin = join(directory, 'bin');
    await mkdir(bin);
    await writeFile(
      join(bin, 'git'),
      `#!/bin/sh\ntouch "${join(directory, 'ran')}"\necho 'git version 2.43.0'\n`,
    );
    await chmod(join(bin, 'git'), 0o755);
    process.env.PATH = `${bin}:${originalPath}`;

    await registry(new ChildProcessExecutor()).refresh();

    await expect(stat(join(directory, 'ran'))).resolves.toBeTruthy();
    expect(lookup(join(roots['vm-p'], '.git'))).toBe(
      `vm-p|vm|laptop|${join(home, 'state', 'vm-p')}`,
    );
  });

  it('lists no project when Git is older than 2.31', async () => {
    version = 'git version 2.30.9\n';
    await registry().refresh();

    expect(lookup(join(roots['vm-p'], '.git'))).toBe('|||');
    expect(await readdir(join(home, 'state'))).toEqual([]);
  });
});
