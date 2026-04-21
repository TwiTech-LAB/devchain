import { Injectable, Inject, OnModuleDestroy } from '@nestjs/common';
import { readFile, writeFile, rename } from 'fs/promises';
import { spawn } from 'child_process';
import * as path from 'path';
import { Provider } from '../../storage/models/domain.models';
import { createLogger } from '../../../common/logging/logger';
import { ProviderAdapterFactory, McpServerEntry } from '../../providers/adapters';
import { OpencodeAdapter } from '../../providers/adapters/opencode.adapter';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { UnsupportedProviderError } from '../../../common/errors/error-types';
import { resolveBinary } from '../../../common/resolve-binary';
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

    const resolved = await resolveBinary(candidate);
    if (resolved) {
      return {
        success: true,
        binaryPath: resolved,
        source: path.isAbsolute(candidate) ? 'configured' : 'which',
      };
    }

    logger.warn({ provider: provider.name, candidate }, 'Binary resolution failed');
    return {
      success: false,
      message: `Unable to resolve binary '${candidate}' for provider ${provider.name}.`,
    };
  }

  async registerProvider(
    provider: Provider,
    options: McpRegisterOptions,
    execOptions?: { cwd?: string; timeoutMs?: number },
  ): Promise<McpCommandResult> {
    try {
      const adapter = this.adapterFactory.getAdapter(provider.name);

      if (adapter.mcpMode === 'project_config') {
        return this.registerProviderViaConfigFile(
          adapter as OpencodeAdapter,
          options,
          execOptions?.cwd,
        );
      }

      return this.registerProviderViaCli(provider, options, execOptions);
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
    try {
      const adapter = this.adapterFactory.getAdapter(provider.name);

      if (adapter.mcpMode === 'project_config') {
        return this.listRegistrationsFromConfigFile(adapter as OpencodeAdapter, execOptions?.cwd);
      }

      return this.listRegistrationsViaCli(provider, adapter, execOptions);
    } catch (error) {
      if (error instanceof UnsupportedProviderError) {
        return {
          success: false,
          message: error.message,
          entries: [],
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
    try {
      const adapter = this.adapterFactory.getAdapter(provider.name);

      if (adapter.mcpMode === 'project_config') {
        return this.removeRegistrationViaConfigFile(
          adapter as OpencodeAdapter,
          alias,
          execOptions?.cwd,
        );
      }

      return this.removeRegistrationViaCli(provider, alias, execOptions);
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

  // ── CLI-based methods (existing flow, extracted) ──────────────────────

  private async listRegistrationsViaCli(
    provider: Provider,
    adapter: ReturnType<ProviderAdapterFactory['getAdapter']>,
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
  }

  private async registerProviderViaCli(
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

    const adapter = this.adapterFactory.getAdapter(provider.name);
    const args = adapter.addMcpServer({
      endpoint: options.endpoint,
      alias: options.alias,
      extraArgs: options.extraArgs,
    });
    return this.runCommand(resolution.binaryPath, args, execOptions);
  }

  private async removeRegistrationViaCli(
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

    const adapter = this.adapterFactory.getAdapter(provider.name);
    const args = adapter.removeMcpServer(alias);
    return this.runCommand(resolution.binaryPath, args, {
      timeoutMs: execOptions?.timeoutMs ?? 10_000,
      cwd: execOptions?.cwd,
    });
  }

  // ── Config-file-based methods (project_config mode) ──────────────────

  private async listRegistrationsFromConfigFile(
    adapter: OpencodeAdapter,
    cwd?: string,
  ): Promise<McpListResult> {
    if (!cwd) {
      return {
        success: false,
        message: `Provider ${adapter.providerName} requires a project path (cwd) for config-file MCP management`,
        entries: [],
      };
    }

    const configPath = path.join(cwd, adapter.configFileName);

    try {
      const content = await readFile(configPath, 'utf-8');
      const entries = adapter.parseProjectConfig(content);
      return {
        success: true,
        message: `Read ${entries.length} MCP entry(ies) from ${adapter.configFileName}`,
        entries,
      };
    } catch (error: unknown) {
      if (error instanceof SyntaxError) {
        return {
          success: false,
          message: `${adapter.configFileName} is malformed JSON — please fix it manually`,
          entries: [],
        };
      }
      if (this.isNodeError(error) && error.code === 'ENOENT') {
        return {
          success: true,
          message: `${adapter.configFileName} not found — no MCP entries configured`,
          entries: [],
        };
      }
      throw error;
    }
  }

  private async registerProviderViaConfigFile(
    adapter: OpencodeAdapter,
    options: McpRegisterOptions,
    cwd?: string,
  ): Promise<McpCommandResult> {
    if (!cwd) {
      return {
        success: false,
        message: `Provider ${adapter.providerName} requires a project path (cwd) for config-file MCP management`,
        stdout: '',
        stderr: '',
        exitCode: null,
      };
    }

    const configPath = path.join(cwd, adapter.configFileName);
    let config: Record<string, unknown> = {};

    try {
      const content = await readFile(configPath, 'utf-8');
      const parsed = JSON.parse(content);
      if (!this.isPlainRecord(parsed)) {
        return {
          success: false,
          message: `${adapter.configFileName} has invalid root structure (expected JSON object) — please fix it manually`,
          stdout: '',
          stderr: '',
          exitCode: null,
        };
      }
      config = parsed;
    } catch (error: unknown) {
      if (error instanceof SyntaxError) {
        return {
          success: false,
          message: `${adapter.configFileName} is malformed JSON — please fix it manually before registering MCP`,
          stdout: '',
          stderr: '',
          exitCode: null,
        };
      }
      if (this.isNodeError(error) && error.code === 'ENOENT') {
        // File doesn't exist — start from empty config
        config = {};
      } else {
        throw error;
      }
    }

    const entry = adapter.buildMcpConfigEntry(options);
    if (config.mcp !== undefined && !this.isPlainRecord(config.mcp)) {
      return {
        success: false,
        message: `${adapter.configFileName} has invalid "mcp" field (expected object) — please fix it manually`,
        stdout: '',
        stderr: '',
        exitCode: null,
      };
    }
    const mcp = (config.mcp as Record<string, unknown>) ?? {};
    mcp[entry.key] = entry.value;
    config.mcp = mcp;

    const tmpPath = configPath + '.tmp';
    await writeFile(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    await rename(tmpPath, configPath);

    return {
      success: true,
      message: `MCP entry '${entry.key}' written to ${adapter.configFileName}`,
      stdout: '',
      stderr: '',
      exitCode: 0,
    };
  }

  private async removeRegistrationViaConfigFile(
    adapter: OpencodeAdapter,
    alias: string,
    cwd?: string,
  ): Promise<McpCommandResult> {
    if (!cwd) {
      return {
        success: false,
        message: `Provider ${adapter.providerName} requires a project path (cwd) for config-file MCP management`,
        stdout: '',
        stderr: '',
        exitCode: null,
      };
    }

    const configPath = path.join(cwd, adapter.configFileName);
    let config: Record<string, unknown>;

    try {
      const content = await readFile(configPath, 'utf-8');
      const parsed = JSON.parse(content);
      if (!this.isPlainRecord(parsed)) {
        return {
          success: false,
          message: `${adapter.configFileName} has invalid root structure (expected JSON object) — please fix it manually`,
          stdout: '',
          stderr: '',
          exitCode: null,
        };
      }
      config = parsed;
    } catch (error: unknown) {
      if (error instanceof SyntaxError) {
        return {
          success: false,
          message: `${adapter.configFileName} is malformed JSON — please fix it manually`,
          stdout: '',
          stderr: '',
          exitCode: null,
        };
      }
      if (this.isNodeError(error) && error.code === 'ENOENT') {
        return {
          success: true,
          message: `${adapter.configFileName} not found — nothing to remove`,
          stdout: '',
          stderr: '',
          exitCode: 0,
        };
      }
      throw error;
    }

    if (config.mcp !== undefined && !this.isPlainRecord(config.mcp)) {
      return {
        success: false,
        message: `${adapter.configFileName} has invalid "mcp" field (expected object) — please fix it manually`,
        stdout: '',
        stderr: '',
        exitCode: null,
      };
    }
    const mcp = config.mcp as Record<string, unknown> | undefined;
    if (!mcp || !(alias in mcp)) {
      return {
        success: true,
        message: `MCP entry '${alias}' not found in ${adapter.configFileName}`,
        stdout: '',
        stderr: '',
        exitCode: 0,
      };
    }

    delete mcp[alias];
    config.mcp = mcp;

    const tmpPath = configPath + '.tmp';
    await writeFile(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    await rename(tmpPath, configPath);

    return {
      success: true,
      message: `MCP entry '${alias}' removed from ${adapter.configFileName}`,
      stdout: '',
      stderr: '',
      exitCode: 0,
    };
  }

  private isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error;
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
