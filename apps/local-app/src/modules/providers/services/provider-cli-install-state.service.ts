import { Inject, Injectable } from '@nestjs/common';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ProviderCliInstallStatusSchema,
  type ProviderCliInstallStatus,
  type ProviderCliName,
} from '@devchain/shared';

export const PROVIDER_CLI_INSTALL_ROOT = Symbol('PROVIDER_CLI_INSTALL_ROOT');

const StateSchema = ProviderCliInstallStatusSchema.extend({
  previousVersion: z.string().nullable(),
  originalBinPath: z.string().nullable().optional(),
});
export type ProviderCliLocalState = z.infer<typeof StateSchema>;

/** Local paths and recovery metadata never enter synced provider settings. */
@Injectable()
export class ProviderCliInstallStateService {
  constructor(@Inject(PROVIDER_CLI_INSTALL_ROOT) readonly root: string) {}

  directory(provider: ProviderCliName): string {
    return join(this.root, provider);
  }

  link(provider: ProviderCliName): string {
    return join(this.root, 'bin', provider);
  }

  read(provider: ProviderCliName): ProviderCliLocalState {
    try {
      return StateSchema.parse(
        JSON.parse(readFileSync(join(this.directory(provider), 'state.json'), 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return {
        desiredVersion: 'latest',
        installedVersion: null,
        previousVersion: null,
        state: 'idle',
        error: null,
        checkedAt: null,
      };
    }
  }

  getStatus(provider: ProviderCliName): ProviderCliInstallStatus {
    const { desiredVersion, installedVersion, state, error, checkedAt } = this.read(provider);
    return { desiredVersion, installedVersion, state, error, checkedAt };
  }

  write(provider: ProviderCliName, state: ProviderCliLocalState): void {
    this.writeJsonAtomic(join(this.directory(provider), 'state.json'), StateSchema.parse(state));
  }

  /** Merges `partial` into the current state and writes it back. */
  patch(provider: ProviderCliName, partial: Partial<ProviderCliLocalState>): void {
    this.write(provider, { ...this.read(provider), ...partial });
  }

  /** Writes `value` as JSON through a temporary file, so a reader never sees a partial file. */
  writeJsonAtomic(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, path);
  }
}
