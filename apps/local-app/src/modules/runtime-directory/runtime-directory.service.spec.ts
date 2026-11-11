/**
 * Unit layer: resolution depends only on host facts (platform, env, linger, statfs), which the
 * `RuntimeDirectoryHost` seam fakes; cleanup runs against real temp directories because the
 * filesystem effect is the behavior.
 */
jest.mock('../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchScriptPath } from '../sessions/services/provider-runtime-preparation/launch-script';
import { quoteShellArg } from '../terminal/services/terminal-io/quote-shell-arg';
import {
  type RuntimeDirectoryEnv,
  type RuntimeDirectoryHost,
  runtimeInstanceId,
} from './runtime-directory';
import { RuntimeDirectoryService } from './runtime-directory.service';

const TMPFS = 0x01021994;
const EXT4 = 0xef53;
const DB_PATH = '/home/dev/.devchain/devchain.db';
const INSTANCE = `devchain-${runtimeInstanceId(DB_PATH)}`;
const FALLBACK = `/home/dev/.devchain/runtime-context/${INSTANCE}`;

interface FakeHostInput {
  platform?: NodeJS.Platform;
  dbPath?: string;
  env?: RuntimeDirectoryEnv;
  lingering?: boolean;
  fsType?: number | null;
}

function fakeHost(input: FakeHostInput = {}): RuntimeDirectoryHost {
  return {
    platform: input.platform ?? 'linux',
    dbPath: input.dbPath ?? DB_PATH,
    env: () => input.env ?? {},
    isLingering: () => input.lingering ?? false,
    fileSystemType: async () => (input.fsType === undefined ? TMPFS : input.fsType),
  };
}

describe('RuntimeDirectoryService', () => {
  describe('resolve', () => {
    it.each<[string, FakeHostInput, { path: string; protection: string; lingerHint: boolean }]>([
      [
        'systemd RUNTIME_DIRECTORY on tmpfs',
        { env: { RUNTIME_DIRECTORY: '/run/devchain', XDG_RUNTIME_DIR: '/run/user/1000' } },
        { path: `/run/devchain/${INSTANCE}`, protection: 'memory', lingerHint: false },
      ],
      [
        'the first of several systemd RUNTIME_DIRECTORY entries',
        { env: { RUNTIME_DIRECTORY: '/run/devchain:/run/other' }, fsType: EXT4 },
        { path: `/run/devchain/${INSTANCE}`, protection: 'disk', lingerHint: false },
      ],
      [
        'XDG_RUNTIME_DIR on tmpfs when the user lingers',
        { env: { XDG_RUNTIME_DIR: '/run/user/1000' }, lingering: true },
        { path: `/run/user/1000/${INSTANCE}`, protection: 'memory', lingerHint: false },
      ],
      [
        'the DB directory with the linger hint when the user does not linger',
        { env: { XDG_RUNTIME_DIR: '/run/user/1000' }, lingering: false },
        { path: FALLBACK, protection: 'disk', lingerHint: true },
      ],
      [
        'the DB directory when XDG_RUNTIME_DIR is not tmpfs',
        { env: { XDG_RUNTIME_DIR: '/run/user/1000' }, lingering: true, fsType: EXT4 },
        { path: FALLBACK, protection: 'disk', lingerHint: false },
      ],
      [
        'macOS TMPDIR',
        { platform: 'darwin', env: { TMPDIR: '/var/folders/ab/cd/T/', XDG_RUNTIME_DIR: '/x' } },
        { path: `/var/folders/ab/cd/T/${INSTANCE}`, protection: 'disk', lingerHint: false },
      ],
      [
        'the DB directory on Linux without XDG_RUNTIME_DIR',
        { env: { TMPDIR: '/tmp' } },
        { path: FALLBACK, protection: 'disk', lingerHint: false },
      ],
      [
        'the DB directory when env paths are relative',
        { env: { RUNTIME_DIRECTORY: 'run', XDG_RUNTIME_DIR: 'user' }, lingering: true },
        { path: FALLBACK, protection: 'disk', lingerHint: false },
      ],
    ])('uses %s', async (_name, host, expected) => {
      await expect(new RuntimeDirectoryService(fakeHost(host)).resolve()).resolves.toEqual(
        expected,
      );
    });

    it('gives instances with different DB paths different directories', async () => {
      const env = { XDG_RUNTIME_DIR: '/run/user/1000' };
      const first = new RuntimeDirectoryService(fakeHost({ env, lingering: true }));
      const second = new RuntimeDirectoryService(
        fakeHost({ env, lingering: true, dbPath: '/home/dev/other/devchain.db' }),
      );

      expect((await first.resolve()).path).not.toBe((await second.resolve()).path);
    });

    it('resolves again on each call and reports the status of the current resolution', async () => {
      let lingering = false;
      const service = new RuntimeDirectoryService({
        ...fakeHost({ env: { XDG_RUNTIME_DIR: '/run/user/1000' } }),
        isLingering: () => lingering,
      });

      await expect(service.getStatus()).resolves.toEqual({ protection: 'disk', lingerHint: true });
      lingering = true;
      await expect(service.getStatus()).resolves.toEqual({
        protection: 'memory',
        lingerHint: false,
      });
    });

    // 255 bytes is the POSIX minimum MAX_CANON and far below MAX_TYPED_COMMAND_BYTES.
    it.each<[string, FakeHostInput]>([
      ['XDG', { env: { XDG_RUNTIME_DIR: '/run/user/4294967294' }, lingering: true }],
      [
        'macOS TMPDIR',
        {
          platform: 'darwin',
          env: { TMPDIR: '/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T/' },
        },
      ],
      ['the DB-directory fallback', { dbPath: '/Users/firstname.lastname/.devchain/devchain.db' }],
    ])('keeps the typed launch line short under %s', async (_name, host) => {
      const { path } = await new RuntimeDirectoryService(fakeHost(host)).resolve();
      const typedLine = ['/bin/sh', launchScriptPath(path)].map(quoteShellArg).join(' ');

      expect(Buffer.byteLength(typedLine, 'utf8')).toBeLessThanOrEqual(255);
    });
  });

  describe('cleanup', () => {
    let tempRoot: string;
    let memoryRoot: string;
    let dbDirectory: string;
    let service: RuntimeDirectoryService;

    beforeEach(() => {
      tempRoot = mkdtempSync(join(tmpdir(), 'devchain-runtime-directory-'));
      memoryRoot = join(tempRoot, 'run');
      dbDirectory = join(tempRoot, 'home');
      service = new RuntimeDirectoryService(
        fakeHost({
          dbPath: join(dbDirectory, 'devchain.db'),
          env: { RUNTIME_DIRECTORY: memoryRoot },
        }),
      );
    });

    afterEach(() => rmSync(tempRoot, { recursive: true, force: true }));

    function writeFiles(root: string, relativePaths: string[]): void {
      for (const relativePath of relativePaths) {
        mkdirSync(join(root, relativePath, '..'), { recursive: true });
        writeFileSync(join(root, relativePath), 'x');
      }
    }

    it('removes orphaned launch scripts and non-live session files in every instance root and the pre-instance roots at startup', async () => {
      const legacy = join(dbDirectory, 'runtime-context');
      const fallback = join(
        legacy,
        `devchain-${runtimeInstanceId(join(dbDirectory, 'devchain.db'))}`,
      );
      const memoryInstance = join(
        memoryRoot,
        `devchain-${runtimeInstanceId(join(dbDirectory, 'devchain.db'))}`,
      );
      for (const root of [memoryInstance, memoryRoot, fallback, legacy]) {
        writeFiles(root, [
          'launch/orphan.sh',
          'session-files/live/key.pem',
          'session-files/dead/key.pem',
          'session-files/stopped/key.pem',
        ]);
      }
      writeFiles(legacy, ['sessions/claude-locator.json', 'endpoint.json']);

      await service.reconcileStartup(new Set(['dead']), new Set(['live']));

      for (const root of [memoryInstance, memoryRoot, fallback, legacy]) {
        expect(readdirSync(join(root, 'launch'))).toEqual([]);
        expect(readdirSync(join(root, 'session-files'))).toEqual(['live']);
      }
      expect(existsSync(join(legacy, 'sessions/claude-locator.json'))).toBe(true);
      expect(existsSync(join(legacy, 'endpoint.json'))).toBe(true);
    });

    it.each<[string, Pick<FakeHostInput, 'env' | 'lingering'>]>([
      ['the same DB directory', { env: { XDG_RUNTIME_DIR: '/run/user/1000' }, lingering: false }],
      ['the same systemd RUNTIME_DIRECTORY', { env: { RUNTIME_DIRECTORY: '/run/devchain' } }],
    ])('keeps the files of another instance in %s', async (_name, input) => {
      const env = input.env?.RUNTIME_DIRECTORY ? { RUNTIME_DIRECTORY: memoryRoot } : input.env;
      const hostFor = (dbFile: string) =>
        fakeHost({ ...input, env, dbPath: join(dbDirectory, dbFile) });
      const work = new RuntimeDirectoryService(hostFor('work.db'));
      const personal = new RuntimeDirectoryService(hostFor('personal.db'));
      const workRoot = (await work.resolve()).path;
      const personalRoot = (await personal.resolve()).path;
      writeFiles(personalRoot, ['launch/pending.sh', 'session-files/running/key.pem']);
      // The VM Vault cache is per unit user, at the bare systemd root.
      writeFiles(memoryRoot, ['vault-cache.json']);

      await work.reconcileStartup(new Set(), new Set());
      await work.cleanupSession('running');

      expect(workRoot).not.toBe(personalRoot);
      expect(existsSync(join(personalRoot, 'launch/pending.sh'))).toBe(true);
      expect(existsSync(join(personalRoot, 'session-files/running/key.pem'))).toBe(true);
      expect(existsSync(join(memoryRoot, 'vault-cache.json'))).toBe(true);
    });

    it('removes only the ended session directory and ignores ids that are not safe paths', async () => {
      writeFiles(memoryRoot, ['session-files/ended/key.pem', 'session-files/other/key.pem']);
      writeFiles(tempRoot, ['outside/key.pem']);

      await service.cleanupSession('ended');
      await service.cleanupSession('../../outside');

      expect(readdirSync(join(memoryRoot, 'session-files'))).toEqual(['other']);
      expect(existsSync(join(tempRoot, 'outside/key.pem'))).toBe(true);
    });
  });
});
