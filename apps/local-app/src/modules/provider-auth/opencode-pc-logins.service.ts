import { homedir } from 'node:os';
import { Inject, Injectable } from '@nestjs/common';
import { resolveBinary } from '../../common/resolve-binary';
import { createLogger } from '../../common/logging/logger';
import { isOpencodeV2 } from '../providers/adapters/opencode-cli-version';
import { ProviderCliVersionProbe } from '../providers/services/provider-cli-version-probe.service';
import { STORAGE_SERVICE, type ProviderStorage } from '../storage/interfaces/storage.interface';
import { ProcessExecutor } from '../terminal/services/process-executor/process-executor.port';
import { readOpencodeAuthFileV1 } from './opencode-pc-logins.v1';
import { exportOpencodeLoginsV2 } from './opencode-pc-logins.v2';

const logger = createLogger('OpencodePcLoginsReader');

/**
 * The logins of the OpenCode this PC runs (the provider's configured binary, else
 * `opencode` on PATH), in the v1 `auth.json` entry shape keyed by provider id.
 */
@Injectable()
export class OpencodePcLoginsReader {
  constructor(
    private readonly probe: ProviderCliVersionProbe,
    private readonly executor: ProcessExecutor,
    @Inject(STORAGE_SERVICE) private readonly storage: Pick<ProviderStorage, 'listProviders'>,
  ) {}

  /** Null when nothing can be read. Without a binary that reports 2.x, reads `auth.json`. */
  async read(): Promise<Record<string, unknown> | null> {
    const binPath = await this.binPath();
    if (binPath) {
      const version = await this.probe.probe('opencode', binPath).catch((error: unknown) => {
        logger.warn({ binPath, error: String(error) }, 'Could not read the OpenCode version');
        return null;
      });
      if (version !== null && isOpencodeV2(version)) {
        return exportOpencodeLoginsV2(this.executor, binPath);
      }
    }
    return readOpencodeAuthFileV1(homedir());
  }

  private async binPath(): Promise<string | null> {
    const { items } = await this.storage.listProviders();
    const configured = items.find((row) => row.name.toLowerCase() === 'opencode')?.binPath;
    return resolveBinary(configured || 'opencode', this.executor);
  }
}
