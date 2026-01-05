import { Injectable, Inject, OnModuleDestroy } from '@nestjs/common';
import { access } from 'fs/promises';
import { constants } from 'fs';
import { execFile, spawn } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import { Provider } from '../../storage/models/domain.models';
import { createLogger } from '../../../common/logging/logger';
import { ProviderAdapterFactory, McpServerEntry } from '../../providers/adapters';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { UnsupportedProviderError } from '../../../common/errors/error-types';

const execFileAsync = promisify(execFile);
const logger = createLogger('McpProviderRegistrationService');

export interface McpCommandResult {
  success: boolean;
  message: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  binaryPath?: string;
}

export interface McpBinaryResolution {
  success: boolean;
  message?: string;
  binaryPath?: string;
  source?: 'configured' | 'which';
}

export interface McpRegisterOptions {
  endpoint: string;
  alias?: string;
  extraArgs?: string[];
}

export interface McpListResult {
  success: boolean;
  message: string;
  entries: McpServerEntry[];
  binaryPath?: string;
  stdout?: string;
  stderr?: string;
}

@Injectable()
export class McpProviderRegistrationService implements OnModuleDestroy {
  constructor(
    private readonly adapterFactory: ProviderAdapterFactory,
    @Inject('STORAGE_SERVICE') private readonly storage: StorageService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    logger.info('Cleaning up MCP registrations on shutdown...');

    try {
      const providersResult = await this.storage.listProviders();
      const codexProvider = providersResult.items.find((p) => p.name === 'codex');

      if (codexProvider?.mcpConfigured) {
        logger.info('Removing devchain MCP registration from Codex...');
        const result = await this.removeRegistration(codexProvider, 'devchain', {
          timeoutMs: 5000,
        });

        if (result.success) {
          logger.info('Codex MCP cleanup complete');
        } else {
          logger.warn({ message: result.message }, 'Codex MCP cleanup returned non-success');
        }
      } else {
        logger.debug('Codex provider not configured with MCP, skipping cleanup');
      }
    } catch (error) {
      logger.error({ error }, 'Failed to cleanup Codex MCP registration');
    }
  }

  runShellCommand(
    command: string,
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<McpCommandResult> {
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
    return new Promise((resolve) => {
      const child = spawn(shell, args, { env: process.env, cwd: options?.cwd });
      let stdout = '';
      let stderr = '';
      const timeoutMs = options?.timeoutMs ?? undefined;
      let timedOut = false;
      let timeout: NodeJS.Timeout | undefined;

      child.stdout?.on('data', (d) => (stdout += d.toString()));
      child.stderr?.on('data', (d) => (stderr += d.toString()));

      if (timeoutMs && timeoutMs > 0) {
        timeout = setTimeout(() => {
          timedOut = true;
          try {
            child.kill('SIGTERM');
          } catch {}
          setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {}
          }, 2000);
        }, timeoutMs);
      }

      child.on('error', (error) => {
        if (timeout) clearTimeout(timeout);
        resolve({
          success: false,
          message: error instanceof Error ? error.message : 'Failed to execute command',
          stdout,
          stderr,
          exitCode: null,
        });
      });

      child.on('close', (code) => {
        if (timeout) clearTimeout(timeout);
        if (timedOut) {
          return resolve({
            success: false,
            message: `Command timed out after ${timeoutMs}ms`,
            stdout,
            stderr,
            exitCode: null,
          });
        }
        const success = code === 0;
        resolve({
          success,
          message: success ? 'Command succeeded' : `Command exited with code ${code}.`,
          stdout,
          stderr,
          exitCode: code,
        });
      });
    });
  }
  async resolveBinary(provider: Provider): Promise<McpBinaryResolution> {
    const candidate = provider.binPath ?? provider.name;
    if (!candidate) {
      return {
        success: false,
        message: `No binary candidate available for provider ${provider.name}`,
      };
    }

    // If absolute path, verify directly; if not, resolve via PATH first
    if (path.isAbsolute(candidate)) {
      return this.verifyBinary(candidate, 'configured');
    }

    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const { stdout } = await execFileAsync(whichCmd, [candidate]);
      const discovered = stdout.trim().split(/\r?\n/)[0] || '';
      if (!discovered) {
        return {
          success: false,
          message: `Unable to locate binary '${candidate}' using '${whichCmd}'.`,
        };
      }
      return this.verifyBinary(discovered, 'which');
    } catch (error) {
      logger.warn({ provider: provider.name, candidate, error }, 'Binary discovery failed');
      return {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : `Unable to discover binary for provider ${provider.name}`,
      };
    }
  }

  async registerProvider(
    provider: Provider,
    options: McpRegisterOptions,
    execOptions?: { cwd?: string; timeoutMs?: number },
  ): Promise<McpCommandResult> {
    const resolution = await this.resolveBinary(provider);
    if (!resolution.success || !resolution.binaryPath) {
      return {
        success: false,
        message: resolution.message ?? 'Unable to resolve provider binary',
        stdout: '',
        stderr: '',
        exitCode: null,
      };
    }

    try {
      const adapter = this.adapterFactory.getAdapter(provider.name);
      const args = adapter.addMcpServer({
        endpoint: options.endpoint,
        alias: options.alias,
        extraArgs: options.extraArgs,
      });
      return this.runCommand(resolution.binaryPath, args, execOptions);
    } catch (error) {
      if (error instanceof UnsupportedProviderError) {
        return {
          success: false,
          message: error.message,
          stdout: '',
          stderr: '',
          exitCode: null,
        };
      }
      throw error;
    }
  }

  async listRegistrations(
    provider: Provider,
    execOptions?: { cwd?: string; timeoutMs?: number },
  ): Promise<McpListResult> {
    const resolution = await this.resolveBinary(provider);
    if (!resolution.success || !resolution.binaryPath) {
      return {
        success: false,
        message: resolution.message ?? 'Unable to resolve provider binary',
        entries: [],
        binaryPath: undefined,
        stdout: '',
        stderr: '',
      };
    }

    try {
      const adapter = this.adapterFactory.getAdapter(provider.name);
      const args = adapter.listMcpServers();
      const result = await this.runCommand(resolution.binaryPath, args, {
        timeoutMs: execOptions?.timeoutMs ?? 10_000,
        cwd: execOptions?.cwd,
      });

      if (!result.success) {
        return {
          success: false,
          message: result.message,
          entries: [],
          binaryPath: result.binaryPath,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      }

      const entries = adapter.parseListOutput(result.stdout, result.stderr);
      return {
        success: true,
        message: result.message,
        entries,
        binaryPath: result.binaryPath,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error) {
      if (error instanceof UnsupportedProviderError) {
        return {
          success: false,
          message: error.message,
          entries: [],
          binaryPath: resolution.binaryPath,
          stdout: '',
          stderr: '',
        };
      }
      throw error;
    }
  }

  async removeRegistration(
    provider: Provider,
    alias: string,
    execOptions?: { cwd?: string; timeoutMs?: number },
  ): Promise<McpCommandResult> {
    const resolution = await this.resolveBinary(provider);
    if (!resolution.success || !resolution.binaryPath) {
      return {
        success: false,
        message: resolution.message ?? 'Unable to resolve provider binary',
        stdout: '',
        stderr: '',
        exitCode: null,
      };
    }

    try {
      const adapter = this.adapterFactory.getAdapter(provider.name);
      const args = adapter.removeMcpServer(alias);
      return this.runCommand(resolution.binaryPath, args, {
        timeoutMs: execOptions?.timeoutMs ?? 10_000,
        cwd: execOptions?.cwd,
      });
    } catch (error) {
      if (error instanceof UnsupportedProviderError) {
        return {
          success: false,
          message: error.message,
          stdout: '',
          stderr: '',
          exitCode: null,
        };
      }
      throw error;
    }
  }

  private async verifyBinary(
    candidate: string,
    source: 'configured' | 'which',
  ): Promise<McpBinaryResolution> {
    try {
      await access(candidate, constants.X_OK);
      return {
        success: true,
        binaryPath: candidate,
        source,
      };
    } catch (error) {
      logger.warn({ candidate, error }, 'Binary verification failed');
      return {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : `Binary ${candidate} is not accessible or executable.`,
      };
    }
  }

  private runCommand(
    binaryPath: string,
    args: string[],
    options?: { timeoutMs?: number; cwd?: string },
  ): Promise<McpCommandResult> {
    return new Promise((resolve) => {
      const child = spawn(binaryPath, args, { env: process.env, cwd: options?.cwd });
      let stdout = '';
      let stderr = '';
      const timeoutMs = options?.timeoutMs ?? undefined;
      let timedOut = false;
      let timeout: NodeJS.Timeout | undefined;

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      if (timeoutMs && timeoutMs > 0) {
        timeout = setTimeout(() => {
          timedOut = true;
          try {
            child.kill('SIGTERM');
          } catch {}
          setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {}
          }, 2000);
        }, timeoutMs);
      }

      child.on('error', (error) => {
        logger.error({ binaryPath, args, error }, 'MCP command failed to spawn');
        if (timeout) clearTimeout(timeout);
        resolve({
          success: false,
          message: error instanceof Error ? error.message : 'Failed to execute MCP command',
          stdout,
          stderr,
          exitCode: null,
          binaryPath,
        });
      });

      child.on('close', (code) => {
        if (timeout) clearTimeout(timeout);
        if (timedOut) {
          return resolve({
            success: false,
            message: `MCP check timed out after ${timeoutMs}ms`,
            stdout,
            stderr,
            exitCode: null,
            binaryPath,
          });
        }

        const success = code === 0;
        const message = success
          ? 'MCP command completed successfully.'
          : `MCP command exited with code ${code}.`;
        if (!success) {
          logger.warn({ binaryPath, args, code, stderr }, 'MCP command exited with error');
        }
        resolve({
          success,
          message,
          stdout,
          stderr,
          exitCode: code,
          binaryPath,
        });
      });
    });
  }
}
