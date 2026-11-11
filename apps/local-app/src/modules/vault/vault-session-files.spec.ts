/**
 * Lifecycle of per-session Vault files. Unit layer over real temp directories:
 * the files must sit where the runtime directory's teardown and startup sweep
 * look, and the filesystem effect is the behavior.
 */
jest.mock('../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeDirectoryHost } from '../runtime-directory/runtime-directory';
import { RuntimeDirectoryService } from '../runtime-directory/runtime-directory.service';
import {
  vaultSessionFilePath,
  vaultSessionFilesDirectory,
  writeVaultSessionFiles,
} from './vault-session-files';

describe('Vault session files', () => {
  let root: string;
  let runtime: RuntimeDirectoryService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'devchain-vault-files-'));
    const host: RuntimeDirectoryHost = {
      platform: 'linux',
      dbPath: join(root, 'db', 'devchain.db'),
      env: () => ({ RUNTIME_DIRECTORY: join(root, 'run') }),
      isLingering: () => false,
      fileSystemType: async () => null,
    };
    runtime = new RuntimeDirectoryService(host);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function writeFor(sessionId: string): Promise<string> {
    const directory = vaultSessionFilesDirectory((await runtime.resolve()).path, sessionId);
    await writeVaultSessionFiles(
      directory,
      [{ name: 'KEY_FILE', content: Buffer.from('pem') }],
      new Set(['KEY_FILE']),
    );
    return join(directory, 'KEY_FILE');
  }

  it('removes the session files at teardown', async () => {
    const ended = await writeFor('ended');
    const other = await writeFor('other');

    await runtime.cleanupSession('ended');

    expect(existsSync(ended)).toBe(false);
    expect(readFileSync(other, 'utf8')).toBe('pem');
  });

  it('keeps the files of live sessions at startup and removes the rest', async () => {
    const live = await writeFor('live');
    const dead = await writeFor('dead');
    const unknown = await writeFor('unknown');

    await runtime.reconcileStartup(new Set(['dead']), new Set(['live']));

    expect(readFileSync(live, 'utf8')).toBe('pem');
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(unknown)).toBe(false);
  });

  describe('on demand', () => {
    const file = (name: string, content: string) => ({ name, content: Buffer.from(content) });
    let directory: string;

    beforeEach(async () => {
      directory = vaultSessionFilesDirectory((await runtime.resolve()).path, 'session');
    });

    it('lets overlapping writes of different subsets keep each other complete', async () => {
      const granted = new Set(['KEY_A', 'KEY_B']);
      const big = (tag: string) => `${tag}:${'x'.repeat(512 * 1024)}`;
      const rounds = Array.from({ length: 20 }, (_, round) => [
        writeVaultSessionFiles(directory, [file('KEY_A', big(`a${round}`))], granted),
        writeVaultSessionFiles(directory, [file('KEY_B', big(`b${round}`))], granted),
        writeVaultSessionFiles(
          directory,
          [file('KEY_A', big(`a${round}`)), file('KEY_B', big(`b${round}`))],
          granted,
        ),
      ]).flat();

      await Promise.all(rounds);

      expect(readdirSync(directory).sort()).toEqual(['KEY_A', 'KEY_B']);
      for (const name of ['KEY_A', 'KEY_B']) {
        const content = readFileSync(join(directory, name), 'utf8');
        expect(content).toMatch(
          new RegExp(`^${name === 'KEY_A' ? 'a' : 'b'}\\d+:x{${512 * 1024}}$`),
        );
        expect(statSync(join(directory, name)).mode & 0o777).toBe(0o600);
      }
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    });

    it('removes only files of names no longer granted, and keeps the directory', async () => {
      await writeVaultSessionFiles(
        directory,
        [file('KEPT', 'kept'), file('REVOKED', 'old')],
        new Set(['KEPT', 'REVOKED']),
      );

      await writeVaultSessionFiles(directory, [], new Set(['KEPT']));
      expect(readdirSync(directory)).toEqual(['KEPT']);

      await writeVaultSessionFiles(directory, [], new Set());
      expect(existsSync(directory)).toBe(true);
      expect(readdirSync(directory)).toEqual([]);
    });
  });

  it.each(['../escape', 'a/b', '', 'NAME.txt'])('refuses the file name %p', (name) => {
    expect(() => vaultSessionFilePath(join(root, 'vault'), name)).toThrow();
  });
});
