import type { Provider } from '../../../storage/models/domain.models';
import type { McpServerEntry } from '../../adapters/provider-adapter.interface';

export interface McpExecOptions {
  cwd?: string;
  timeoutMs?: number;
}

export interface McpRegisterOptions {
  endpoint: string;
  alias?: string;
  extraArgs?: string[];
}

export interface McpCommandResult {
  success: boolean;
  message: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  binaryPath?: string;
}

export interface McpListResult {
  success: boolean;
  message: string;
  entries: McpServerEntry[];
  binaryPath?: string;
  stdout?: string;
  stderr?: string;
}

export interface EnsureRegistrationResult {
  success: boolean;
  action: 'already_configured' | 'fixed_mismatch' | 'added' | 'error';
  message?: string;
  endpoint?: string;
  alias?: string;
}

export interface McpRegistrationAdapter {
  register(
    provider: Provider,
    options: McpRegisterOptions,
    execOptions?: McpExecOptions,
  ): Promise<McpCommandResult>;
  list(provider: Provider, execOptions?: McpExecOptions): Promise<McpListResult>;
  remove(
    provider: Provider,
    alias: string,
    execOptions?: McpExecOptions,
  ): Promise<McpCommandResult>;
  ensure(
    provider: Provider,
    options: { endpoint: string; alias: string },
    execOptions?: McpExecOptions,
  ): Promise<EnsureRegistrationResult>;
}
