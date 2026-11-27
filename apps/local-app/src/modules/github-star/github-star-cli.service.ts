import { Injectable } from '@nestjs/common';
import { createLogger } from '../../common/logging/logger';
import {
  inheritableEnv,
  ProcessExecutor,
  type ExecutorResult,
} from '../terminal/services/process-executor/process-executor.port';
import { GITHUB_STAR_REPO } from './github-star.dto';
import type { GithubStarCheckResult, GithubStarGh } from './github-star-gh.port';

const logger = createLogger('GithubStarCliService');

const REPO_PATH = `user/starred/${GITHUB_STAR_REPO}`;
// An inherited GH_HOST could point gh at GitHub Enterprise.
const HOST_ARGS = ['--hostname', 'github.com'];
const CHECK_ARGV = ['gh', 'api', ...HOST_ARGS, '--include', REPO_PATH];
const STAR_ARGV = ['gh', 'api', ...HOST_ARGS, '--silent', '-X', 'PUT', REPO_PATH];
const TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const STATUS_LINE_RE = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/;

/**
 * Stars the repo with the user's `gh` login. gh exits 1 on the 404 answer but
 * still prints the response headers, so the check reads the status line, not the exit code.
 */
@Injectable()
export class GithubStarCliService implements GithubStarGh {
  private inFlightCheck: Promise<GithubStarCheckResult> | null = null;

  constructor(private readonly executor: ProcessExecutor) {}

  isAlreadyStarred(): Promise<GithubStarCheckResult> {
    if (!this.inFlightCheck) {
      this.inFlightCheck = this.check().finally(() => {
        this.inFlightCheck = null;
      });
    }
    return this.inFlightCheck;
  }

  async star(): Promise<boolean> {
    const result = await this.run(STAR_ARGV);
    logger.info({ exitCode: result.exitCode, timedOut: result.timedOut }, 'gh star finished');
    return result.exitCode === 0 && !result.timedOut;
  }

  private async check(): Promise<GithubStarCheckResult> {
    const result = await this.run(CHECK_ARGV);
    const classification = classify(result);
    logger.info(
      { classification, exitCode: result.exitCode, timedOut: result.timedOut },
      'gh star check finished',
    );
    return classification;
  }

  private run(argv: readonly string[]): Promise<ExecutorResult> {
    // The executor replaces the whole environment when `env` is set; gh needs HOME and PATH.
    const env = { ...inheritableEnv(process.env), GH_PROMPT_DISABLED: '1', GH_TELEMETRY: 'false' };
    return this.executor.run({
      argv,
      mode: 'pipe',
      env,
      timeout: TIMEOUT_MS,
      outputLimits: { maxBytes: MAX_OUTPUT_BYTES },
    });
  }
}

function classify(result: ExecutorResult): GithubStarCheckResult {
  if (result.timedOut || result.exitCode === null) return 'unknown';
  const firstLine = result.stdout.split(/\r?\n/, 1)[0] ?? '';
  const status = STATUS_LINE_RE.exec(firstLine)?.[1];
  if (status === '204') return 'starred';
  if (status === '404') return 'not-starred';
  return 'unknown';
}
