import { Injectable } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { getEnvConfig } from '../../common/config/env.config';
import { assertVmHomePath } from '../../common/filesystem/vm-home-path';
import { ValidationError } from '../../common/errors/error-types';
import { ProcessExecutor } from '../terminal/services/process-executor/process-executor.port';
import { projectRepository } from './project-repository';
import {
  SyncChownRequestSchema,
  unsupportedChown,
  type SyncChownRequest,
  type SyncChownResult,
} from './sync-chown.dto';
import { within } from './sync-path-inspection.dto';

@Injectable()
export class SyncChownService {
  constructor(private readonly executor: ProcessExecutor) {}

  async user(): Promise<SyncChownResult['user']> {
    const claim = await readFile(
      join(getEnvConfig().DEVCHAIN_HOST_ETC_DIR, 'claim.json'),
      'utf8',
    ).catch(() => null);
    let user: SyncChownResult['user'] = null;
    if (claim) {
      let value: unknown;
      try {
        value = JSON.parse(claim);
      } catch {
        // A damaged claim names no user, like a missing one; inspections still answer.
        return null;
      }
      const parsed = z
        .object({ userName: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/) })
        .safeParse(value);
      if (!parsed.success) return null;
      const { userName } = parsed.data;
      const account = await this.executor.run({
        argv: ['getent', 'passwd', userName],
        mode: 'pipe',
      });
      const fields = account.stdout.trim().split(':');
      if (account.success && /^\d+$/.test(fields[2] ?? ''))
        user = { name: userName, uid: Number(fields[2]) };
    }
    return user;
  }

  async repair(request: SyncChownRequest): Promise<SyncChownResult> {
    const { root, items } = SyncChownRequestSchema.parse(request);
    if (root !== resolve(root)) throw new ValidationError('The project root must be normalized.');
    await assertVmHomePath(root, {
      code: 'FILE_SYNC_CHOWN_OUTSIDE_HOME',
      message: 'Ownership repairs must be under the VM home',
      linkMessage: 'Ownership paths must not be links',
      rejectAncestorLinks: true,
    });
    const helper = join(getEnvConfig().DEVCHAIN_HOST_BIN_DIR, 'devchain-host-project-chown');
    const user = await this.user();
    if (!user || !existsSync(helper)) return unsupportedChown(user, items);
    const result: SyncChownResult = { user, items: [] };
    let tracked: Map<string, string>;
    try {
      if ((await projectRepository(root)) !== 'repository')
        throw new Error('A regular Git repository is required.');
      const index = await this.git(root, ['ls-files', '-s', '-z']);
      if (!index.success || index.truncated) throw new Error('Git tracking could not be checked.');
      tracked = new Map(
        index.stdout
          .split('\0')
          .filter(Boolean)
          .map((entry) => {
            const match = /^(\d{6}) [a-f0-9]+ (\d+)\t([\s\S]+)$/.exec(entry);
            if (!match) throw new Error('Git returned an invalid index entry.');
            return [match[3], match[2] === '0' ? match[1] : 'unmerged'];
          }),
      );
    } catch (error) {
      return {
        user,
        items: items.map(({ path }) => ({
          path,
          state: 'refused',
          paths: [],
          reason: error instanceof Error ? error.message : 'Git could not be checked.',
        })),
      };
    }
    for (const item of items) {
      const paths: string[] = [];
      try {
        const target = join(root, item.path);
        const info = await this.checked(root, target);
        const parents: string[] = [];
        for (let parent = dirname(target); parent !== root; parent = dirname(parent))
          parents.unshift(parent);
        if (item.mode === 'automatic') {
          if (!['100644', '100755'].includes(tracked.get(item.path) ?? '') || !info.isFile())
            throw new Error('Automatic repair requires a tracked regular file.');
        } else {
          if (!info.isFile() && !info.isDirectory())
            throw new Error('Give to requires a regular file or folder.');
          if (
            [...tracked.keys()].some((name) => within(name, item.path)) ||
            (await this.ignored(root, item.path))
          )
            throw new Error('Give to requires a path Git neither tracks nor ignores.');
          if (info.isDirectory() && (await this.hasGit(target)))
            throw new Error('The selected folder is a repository.');
        }
        const run = async (path: string, mode: '--file' | '--dir' | '--tree') => {
          await this.checked(root, path);
          const response = await this.executor.run({
            argv: ['sudo', '-n', helper, root, mode, path],
            mode: 'pipe',
            timeout: 60_000,
          });
          const remember = (changed: string[]) => {
            for (const changedPath of changed) {
              const name = relative(root, changedPath);
              if (!name || name.startsWith('../') || name.startsWith('/'))
                throw new Error('The helper returned a path outside the project.');
              paths.push(name);
            }
          };
          if (!response.success || response.timedOut || response.truncated) {
            let message = 'The VM refused the ownership repair.';
            try {
              const failure = z
                .object({ message: z.string(), changed: z.array(z.string()).default([]) })
                .parse(JSON.parse(response.stderr.trim().split('\n').at(-1)!));
              message = failure.message;
              remember(failure.changed);
            } catch {
              /* The helper may fail before producing JSON. */
            }
            throw new Error(message);
          }
          const changed = z
            .object({ changed: z.array(z.string()) })
            .parse(JSON.parse(response.stdout)).changed;
          remember(changed);
        };
        for (const parent of parents) {
          const parentInfo = await this.checked(root, parent);
          const name = relative(root, parent);
          const code =
            item.mode === 'give'
              ? !(await this.ignored(root, name))
              : [...tracked.entries()].some(
                  ([file, mode]) =>
                    file.startsWith(name + '/') &&
                    ['100644', '100755'].includes(mode) &&
                    !['.gitkeep', '.keep', '.gitignore'].includes(basename(file)),
                );
          if (parentInfo.uid !== user.uid && code) await run(parent, '--dir');
        }
        const current = await this.checked(root, target);
        if (item.mode === 'give' && current.isDirectory()) await run(target, '--tree');
        else if (current.uid !== user.uid) await run(target, '--file');
        result.items.push({
          path: item.path,
          state: paths.length ? 'repaired' : 'unchanged',
          paths: [...new Set(paths)],
        });
      } catch (error) {
        result.items.push({
          path: item.path,
          state: 'refused',
          paths: [...new Set(paths)],
          reason: error instanceof Error ? error.message : 'The VM refused the ownership repair.',
        });
      }
    }
    return result;
  }

  private git(root: string, args: string[], input?: string) {
    return this.executor.run({
      argv: ['git', '-c', `safe.directory=${root}`, '-C', root, ...args],
      mode: 'pipe',
      input,
      timeout: 30_000,
    });
  }
  private async ignored(root: string, path: string): Promise<boolean> {
    const result = await this.git(
      root,
      ['check-ignore', '--no-index', '-z', '--stdin'],
      path + '\0',
    );
    if (result.timedOut || result.truncated || ![0, 1].includes(result.exitCode ?? -1))
      throw new Error('Git ignore rules could not be checked.');
    return result.exitCode === 0;
  }
  private async hasGit(path: string): Promise<boolean> {
    try {
      await lstat(join(path, '.git'));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  private async checked(root: string, target: string) {
    let current = root;
    for (const part of relative(root, target).split('/').filter(Boolean)) {
      current = join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink() || part === '.git')
        throw new Error('Ownership paths must not contain links or Git metadata.');
      if (info.isDirectory() && current !== root && (await this.hasGit(current)))
        throw new Error('Ownership paths must not enter another repository.');
    }
    return lstat(target);
  }
}
