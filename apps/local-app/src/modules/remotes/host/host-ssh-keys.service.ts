import { Inject, Injectable, Optional } from '@nestjs/common';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ValidationError } from '../../../common/errors/error-types';
import { isKnownSshKeyType } from '../../../common/validation/ssh-public-key';
import { HostHelperService } from './host-helper.service';

export const HOST_SSH_HOME = Symbol('HOST_SSH_HOME');

@Injectable()
export class HostSshKeysService {
  private readonly home: string;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly helper: HostHelperService,
    @Optional() @Inject(HOST_SSH_HOME) home?: string,
  ) {
    this.home = home ?? homedir();
  }

  /** Adds the keys, which the controller has already validated, to `authorized_keys`. */
  apply(keys: string[]): Promise<{ added: number }> {
    this.helper.assertClaimedHost();
    // Serialize read/merge/rename so concurrent requests cannot lose each other's keys.
    const result = this.pending.then(() => this.merge(keys));
    this.pending = result.catch(() => undefined);
    return result;
  }

  private async merge(keys: string[]): Promise<{ added: number }> {
    const directory = join(this.home, '.ssh');
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    await this.assertSafe(directory, true);
    const folder = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await folder.chmod(0o700);
      const path = join(directory, 'authorized_keys');
      await this.assertSafe(path, false);
      let existing = '';
      try {
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          existing = await file.readFile('utf8');
          await file.chmod(0o600);
        } finally {
          await file.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      // A key counts as present by type plus base64 body alone: appending a
      // fresh line for a key that exists with a `from=` or `command=` prefix
      // would install an unrestricted copy of that key.
      const present = new Set(
        existing
          .split(/\r?\n/)
          .map(authorizedKeyIdentity)
          .filter((identity): identity is string => identity !== null),
      );
      const missing = [...new Set(keys)].filter((key) => {
        const identity = authorizedKeyIdentity(key);
        return identity === null || !present.has(identity);
      });
      // Nothing to append: leave the file exactly as read — even a trailing-newline
      // rewrite would count as touching restrictions the VM owner set by hand.
      if (missing.length === 0) return { added: 0 };
      const temporary = join(directory, `.authorized_keys-${randomUUID()}`);
      try {
        const file = await open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(
            existing +
              (existing && !existing.endsWith('\n') ? '\n' : '') +
              missing.map((key) => `${key}\n`).join(''),
            'utf8',
          );
          await file.sync();
        } finally {
          await file.close();
        }
        await this.assertSafe(directory, true);
        await this.assertSafe(path, false);
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
      return { added: missing.length };
    } finally {
      await folder.close();
    }
  }

  private async assertSafe(path: string, directory: boolean): Promise<void> {
    const stats = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (!directory && error.code === 'ENOENT') return null;
      throw error;
    });
    if (stats && (stats.isSymbolicLink() || (directory ? !stats.isDirectory() : !stats.isFile()))) {
      throw new ValidationError(
        'SSH key paths must be regular files and directories, without symlinks.',
      );
    }
  }
}

/**
 * Identity of an `authorized_keys` line — key type plus base64 body — or null
 * when the line holds no key this build recognizes (blank, `#` comment, or an
 * unknown type). Options and comment never take part in the identity.
 */
function authorizedKeyIdentity(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const tokens = tokenizeOutsideQuotes(trimmed);
  for (let index = 0; index + 1 < tokens.length; index++) {
    if (isKnownSshKeyType(tokens[index])) return `${tokens[index]} ${tokens[index + 1]}`;
  }
  return null;
}

/**
 * Whitespace tokens of a line with sshd option syntax: a double-quoted section
 * keeps its spaces, commas and `\"` pairs, so a key type named inside quotes
 * cannot pass for the line's key type.
 */
function tokenizeOutsideQuotes(line: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted && char === '\\') {
      token += char + (line[index + 1] ?? '');
      index++;
    } else if (char === '"') {
      quoted = !quoted;
      token += char;
    } else if (!quoted && (char === ' ' || char === '\t')) {
      if (token) tokens.push(token);
      token = '';
    } else {
      token += char;
    }
  }
  if (token) tokens.push(token);
  return tokens;
}
