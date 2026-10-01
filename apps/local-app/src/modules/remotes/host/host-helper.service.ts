import { Injectable } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { getEnvConfig } from '../../../common/config/env.config';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  ValidationError,
} from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';

const logger = createLogger('HostHelperService');

const HELPER_TIMEOUT_MS = 60_000;

export const HostUpdateStatusSchema = z.object({
  state: z.enum(['pending', 'installing', 'installing_clis', 'restarting', 'done', 'failed']),
  version: z.string(),
  error: z.string().optional(),
  at: z.string(),
});
export type HostUpdateStatus = z.infer<typeof HostUpdateStatusSchema>;

export const HostDockerStatusSchema = z.object({
  jobId: z.string(),
  state: z.enum(['pending', 'installing', 'restarting', 'done', 'failed']),
  error: z.string().optional(),
  code: z.string().optional(),
  at: z.string(),
});
export type HostDockerStatus = z.infer<typeof HostDockerStatusSchema>;
export const HOST_HELPER_MIGRATION =
  'sudo npm install -g /opt/devchain-host/current/lib/node_modules/devchain-cli/dist/host-install/devchain-host-bootstrap.tgz';

export interface ProjectRootResult {
  path: string;
  created: boolean;
}

/** Exit codes of the bootstrap package's root helpers. */
const HELPER_EXIT = { invalid: 2, conflict: 3, refused: 4, notRoot: 77 } as const;

interface HelperFailure {
  exitCode: number | null;
  code: string | null;
  message: string;
}

/**
 * DevChain's side of a claimed host VM: runs the root helpers that the image's
 * bootstrap package installs (`devchain-host-update`,
 * `devchain-host-project-root`) through the sudoers entry the claim wrote.
 * On any other instance there is no claim record and every call is refused.
 */
@Injectable()
export class HostHelperService {
  constructor(private readonly executor: ProcessExecutor) {}

  private get etcDir(): string {
    return getEnvConfig().DEVCHAIN_HOST_ETC_DIR;
  }

  isClaimedHost(): boolean {
    return existsSync(join(this.etcDir, 'claim.json'));
  }

  async requestUpdate(version: string): Promise<void> {
    this.assertClaimedHost();
    await this.runHelper('devchain-host-update', [version]);
  }

  /** The last update's progress, or null before the first update. */
  readUpdateStatus(): HostUpdateStatus | null {
    this.assertClaimedHost();
    let raw: string;
    try {
      raw = readFileSync(join(this.etcDir, 'update.json'), 'utf8');
    } catch {
      return null;
    }
    const parsed = HostUpdateStatusSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  }

  async requestDocker(): Promise<{ jobId: string | null }> {
    this.assertClaimedHost();
    try {
      const stdout = await this.runHelper('devchain-host-update', ['--docker']);
      return z.object({ jobId: z.string().nullable() }).parse(JSON.parse(stdout));
    } catch (error) {
      if (error instanceof AppError && error.details?.code === 'INVALID_VERSION') {
        throw new ConflictError(
          `The host helper needs one manual migration: ${HOST_HELPER_MIGRATION}`,
          { code: 'HOST_HELPER_OUTDATED' },
        );
      }
      throw error;
    }
  }

  readDockerStatus(): HostDockerStatus | null {
    this.assertClaimedHost();
    try {
      const parsed = HostDockerStatusSchema.safeParse(
        JSON.parse(readFileSync(join(this.etcDir, 'docker.json'), 'utf8')),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async createProjectRoot(path: string): Promise<ProjectRootResult> {
    this.assertClaimedHost();
    const stdout = await this.runHelper('devchain-host-project-root', [path]);
    return z.object({ path: z.string(), created: z.boolean() }).parse(JSON.parse(stdout));
  }

  assertClaimedHost(): void {
    if (!this.isClaimedHost()) {
      throw new ConflictError('This DevChain instance is not a claimed host VM.', {
        code: 'NOT_A_HOST',
      });
    }
  }

  private async runHelper(helper: string, args: string[]): Promise<string> {
    const helperPath = join(getEnvConfig().DEVCHAIN_HOST_BIN_DIR, helper);
    const result = await this.executor.run({
      argv: ['sudo', '-n', helperPath, ...args],
      mode: 'pipe',
      timeout: HELPER_TIMEOUT_MS,
    });
    if (result.success && !result.timedOut) return result.stdout;
    const failure = parseFailure(result.timedOut ? null : result.exitCode, result.stderr);
    logger.warn({ helper, exitCode: failure.exitCode, code: failure.code }, 'Host helper failed');
    throw toAppError(helper, failure);
  }
}

function parseFailure(exitCode: number | null, stderr: string): HelperFailure {
  const lastLine = stderr.trim().split('\n').pop() ?? '';
  try {
    const body = JSON.parse(lastLine) as { code?: unknown; message?: unknown };
    return {
      exitCode,
      code: typeof body.code === 'string' ? body.code : null,
      message: typeof body.message === 'string' ? body.message : lastLine,
    };
  } catch {
    return { exitCode, code: null, message: lastLine || `exit code ${exitCode ?? 'unknown'}` };
  }
}

function toAppError(helper: string, failure: HelperFailure): AppError {
  const details = { code: failure.code ?? 'HOST_HELPER_FAILED', helper };
  switch (failure.exitCode) {
    case HELPER_EXIT.invalid:
      return new ValidationError(failure.message, details);
    case HELPER_EXIT.conflict:
      return new ConflictError(failure.message, details);
    case HELPER_EXIT.refused:
      return new ForbiddenError(failure.message, details);
    default:
      return new AppError(
        `${helper} failed: ${failure.message}`,
        'HOST_HELPER_FAILED',
        500,
        details,
      );
  }
}
