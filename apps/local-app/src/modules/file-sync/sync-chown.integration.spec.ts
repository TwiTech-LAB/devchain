import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';
import { resetEnvConfig } from '../../common/config/env.config';
import {
  ProcessExecutor,
  type ProcessExecutorOptions,
} from '../terminal/services/process-executor/process-executor.port';
import { ChildProcessExecutor } from '../terminal/services/process-executor/child-process-executor';
import { HostSyncController } from './host-sync.controller';
import { FileSyncService } from './file-sync.service';
import { SyncPathInspector } from './sync-path-inspector';
import { SyncChownService } from './sync-chown.service';
import type { SyncChownResult } from './sync-chown.dto';

let privileged = process.getuid?.() !== 0;
try {
  execFileSync('sudo', ['-n', 'true']);
} catch {
  privileged = false;
}
const real = privileged ? describe : describe.skip;

// Real Git, lstat and sudo exercise host refusal decisions and the privileged helper together.
real('host ownership repairs', () => {
  let app: NestFastifyApplication;
  let fixture: string;
  let root: string;
  let helper: string;
  let failParent: boolean;
  const calls: string[][] = [];
  const beforeEnv = {
    etc: process.env.DEVCHAIN_HOST_ETC_DIR,
    bin: process.env.DEVCHAIN_HOST_BIN_DIR,
  };
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]);
  const foreign = (path: string) => execFileSync('sudo', ['-n', 'chown', '0:0', path]);
  const file = (name: string, tracked = false) => {
    const path = join(root, name);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, 'source');
    if (tracked) git('add', '--', name);
    return path;
  };
  const repair = async (path: string, mode: 'automatic' | 'give' = 'automatic') => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/host/sync/chown',
      payload: { root, items: [{ path, mode }] },
    });
    expect(response.statusCode).toBe(200);
    return response.json<SyncChownResult>().items[0];
  };
  beforeAll(async () => {
    fixture = mkdtempSync(join(homedir(), '.devchain-chown-test-'));
    const etc = join(fixture, 'etc');
    const bin = join(fixture, 'bin');
    mkdirSync(etc);
    mkdirSync(bin);
    const name = execFileSync('id', ['-un'], { encoding: 'utf8' }).trim();
    writeFileSync(join(etc, 'claim.json'), JSON.stringify({ userName: name }));
    helper = join(bin, 'devchain-host-project-chown');
    const library = resolve(__dirname, '../../../../host-bootstrap/lib/project-chown.js');
    const system = resolve(__dirname, '../../../../host-bootstrap/lib/system.js');
    writeFileSync(
      helper,
      `#!/usr/bin/env node\nconst {repairProjectOwner}=require(${JSON.stringify(library)});\nconst {createSystem}=require(${JSON.stringify(system)});\nrepairProjectOwner(...process.argv.slice(2),createSystem({paths:{etcDir:${JSON.stringify(etc)}}})).then(result=>process.stdout.write(JSON.stringify(result)),error=>{process.stderr.write(JSON.stringify({message:error.message}));process.exit(4);});\n`,
    );
    chmodSync(helper, 0o755);
    process.env.DEVCHAIN_HOST_ETC_DIR = etc;
    process.env.DEVCHAIN_HOST_BIN_DIR = bin;
    resetEnvConfig();
    const child = new ChildProcessExecutor();
    const executor = {
      run: async (options: ProcessExecutorOptions) => {
        calls.push([...options.argv]);
        if (failParent && options.argv.includes('--dir')) {
          failParent = false;
          return {
            success: false,
            exitCode: 4,
            stdout: '',
            stderr: '{"message":"parent failed"}',
            timedOut: false,
            truncated: false,
          };
        }
        return child.run(options);
      },
    };
    const module = await Test.createTestingModule({
      controllers: [HostSyncController],
      providers: [
        SyncChownService,
        SyncPathInspector,
        { provide: ProcessExecutor, useValue: executor },
        { provide: FileSyncService, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  beforeEach(() => {
    root = mkdtempSync(join(fixture, 'project-'));
    git('init', '-q');
    calls.length = 0;
    failParent = false;
  });
  afterAll(async () => {
    await app?.close();
    if (fixture) {
      execFileSync('sudo', [
        '-n',
        'chown',
        '-R',
        `${process.getuid!()}:${process.getgid!()}`,
        fixture,
      ]);
      rmSync(fixture, { recursive: true, force: true });
    }
    for (const [key, value] of [
      ['DEVCHAIN_HOST_ETC_DIR', beforeEnv.etc],
      ['DEVCHAIN_HOST_BIN_DIR', beforeEnv.bin],
    ]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
    resetEnvConfig();
  });

  it('refuses gitlinks, indexed files replaced by directories and untracked automatic items', async () => {
    git('update-index', '--add', '--cacheinfo', '160000,' + 'a'.repeat(40) + ',submodule');
    mkdirSync(join(root, 'submodule'));
    const replaced = file('replaced', true);
    unlinkSync(replaced);
    mkdirSync(replaced);
    const child = file('replaced/untracked');
    foreign(child);
    const untracked = file('untracked');
    foreign(untracked);
    for (const name of ['submodule', 'replaced', 'untracked'])
      expect((await repair(name)).state).toBe('refused');
    expect(lstatSync(child).uid).toBe(0);
    expect(lstatSync(untracked).uid).toBe(0);
    expect(calls.some((argv) => argv[0] === 'sudo')).toBe(false);
  });
  it('repairs a tracked regular file but leaves an already owned file unchanged', async () => {
    const source = file('source.ts', true);
    foreign(source);
    const inspected = await app.inject({
      method: 'POST',
      url: '/api/host/sync/inspect',
      payload: { path: root, scan: false, paths: ['source.ts'] },
    });
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json().vmUser).toEqual({
      uid: process.getuid!(),
      name: execFileSync('id', ['-un'], { encoding: 'utf8' }).trim(),
    });
    expect(await repair('source.ts')).toMatchObject({ state: 'repaired', paths: ['source.ts'] });
    expect(lstatSync(source).uid).toBe(process.getuid!());
    calls.length = 0;
    expect((await repair('source.ts')).state).toBe('unchanged');
    expect(calls.some((argv) => argv[0] === 'sudo')).toBe(false);
  });
  it.each([true, false])(
    'repairs a code parent independently of the file ownership (%s)',
    async (foreignFile) => {
      const source = file('package/source.ts', true);
      if (foreignFile) foreign(source);
      foreign(join(root, 'package'));
      expect((await repair('package/source.ts')).state).toBe('repaired');
      expect(lstatSync(source).uid).toBe(process.getuid!());
      expect(lstatSync(join(root, 'package')).uid).toBe(process.getuid!());
      expect(calls.filter((argv) => argv.includes('--file'))).toHaveLength(foreignFile ? 1 : 0);
    },
  );
  it('keeps a data-only parent owner and completes a retry after a failed code-parent repair', async () => {
    file('data/.gitkeep', true);
    foreign(join(root, 'data'));
    expect((await repair('data/.gitkeep')).state).toBe('unchanged');
    expect(lstatSync(join(root, 'data')).uid).toBe(0);
    file('code/source.ts', true);
    foreign(join(root, 'code'));
    failParent = true;
    expect((await repair('code/source.ts')).state).toBe('refused');
    expect(lstatSync(join(root, 'code')).uid).toBe(0);
    expect((await repair('code/source.ts')).state).toBe('repaired');
    expect(lstatSync(join(root, 'code')).uid).toBe(process.getuid!());
  });
  it('gives a new file and its untracked foreign parent to the VM user', async () => {
    const source = file('new-package/migration.ts');
    foreign(source);
    foreign(join(root, 'new-package'));
    expect((await repair('new-package/migration.ts', 'give')).state).toBe('repaired');
    expect(lstatSync(source).uid).toBe(process.getuid!());
    expect(lstatSync(join(root, 'new-package')).uid).toBe(process.getuid!());
  });
  it('gives an untracked tree while pruning nested .git directories/files and links', async () => {
    const source = file('package/source.ts');
    foreign(source);
    for (const name of ['nested', 'submodule']) {
      const nestedSource = file(`package/${name}/source.ts`);
      foreign(nestedSource);
      if (name === 'nested') mkdirSync(join(root, `package/${name}/.git`));
      else writeFileSync(join(root, `package/${name}/.git`), 'gitdir: elsewhere');
      foreign(join(root, `package/${name}`));
    }
    const outside = file('outside');
    foreign(outside);
    symlinkSync(outside, join(root, 'package/link'));
    foreign(join(root, 'package'));
    expect((await repair('package', 'give')).state).toBe('repaired');
    expect(lstatSync(source).uid).toBe(process.getuid!());
    expect(lstatSync(join(root, 'package')).uid).toBe(process.getuid!());
    for (const name of ['nested', 'submodule']) {
      expect(lstatSync(join(root, `package/${name}`)).uid).toBe(0);
      expect(lstatSync(join(root, `package/${name}/source.ts`)).uid).toBe(0);
      expect((await repair(`package/${name}/source.ts`, 'give')).state).toBe('refused');
      expect((await repair(`package/${name}`, 'give')).state).toBe('refused');
    }
    expect(lstatSync(outside).uid).toBe(0);
  });
  it('refuses ignored Give to paths and links; a missing installed helper is unsupported', async () => {
    writeFileSync(join(root, '.gitignore'), 'data/\n');
    file('data/file');
    expect((await repair('data/file', 'give')).state).toBe('refused');
    const source = file('source', true);
    symlinkSync(source, join(root, 'link'));
    expect((await repair('link', 'give')).state).toBe('refused');
    const original = helper + '.saved';
    execFileSync('mv', [helper, original]);
    try {
      expect((await repair('source')).state).toBe('unsupported');
      const inspected = await app.inject({
        method: 'POST',
        url: '/api/host/sync/inspect',
        payload: { path: root, scan: false, paths: ['source'] },
      });
      expect(inspected.json().vmUser.uid).toBe(process.getuid!());
    } finally {
      execFileSync('mv', [original, helper]);
    }
  });

  it('answers an inspection without a VM user when claim.json is damaged', async () => {
    const claim = join(process.env.DEVCHAIN_HOST_ETC_DIR!, 'claim.json');
    const original = readFileSync(claim, 'utf8');
    writeFileSync(claim, '{not json');
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/host/sync/inspect',
        payload: { path: root, scan: false, paths: [] },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).not.toHaveProperty('vmUser');
    } finally {
      writeFileSync(claim, original);
    }
  });
});
