import { Injectable } from '@nestjs/common';
import type { Provider } from '../../../storage/models/domain.models';
import { ProviderAdapterFactory, isMcpCli, isGlobalMcpConfigCapable } from '../../adapters';
import { CliMcpRegistrationAdapter } from './cli-mcp-registration.adapter';
import { ConfigFileMcpRegistrationAdapter } from './config-file-mcp-registration.adapter';
import { AntigravityMcpRegistrationAdapter } from './antigravity-mcp-registration.adapter';
import type {
  McpExecOptions,
  McpRegisterOptions,
  McpCommandResult,
  McpListResult,
  EnsureRegistrationResult,
  McpRegistrationAdapter,
} from './mcp-registration.types';
export type {
  McpExecOptions,
  McpRegisterOptions,
  McpCommandResult,
  McpListResult,
  EnsureRegistrationResult,
  McpRegistrationAdapter,
} from './mcp-registration.types';

@Injectable()
export class McpRegistrationPort {
  constructor(
    private readonly cli: CliMcpRegistrationAdapter,
    private readonly configFile: ConfigFileMcpRegistrationAdapter,
    private readonly antigravity: AntigravityMcpRegistrationAdapter,
    private readonly adapterFactory: ProviderAdapterFactory,
  ) {}

  async register(
    provider: Provider,
    options: McpRegisterOptions,
    execOptions?: McpExecOptions,
  ): Promise<McpCommandResult> {
    return this.resolveAdapter(provider).register(provider, options, execOptions);
  }

  async list(provider: Provider, execOptions?: McpExecOptions): Promise<McpListResult> {
    return this.resolveAdapter(provider).list(provider, execOptions);
  }

  async remove(
    provider: Provider,
    alias: string,
    execOptions?: McpExecOptions,
  ): Promise<McpCommandResult> {
    return this.resolveAdapter(provider).remove(provider, alias, execOptions);
  }

  async ensure(
    provider: Provider,
    options: { endpoint: string; alias: string },
    execOptions?: McpExecOptions,
  ): Promise<EnsureRegistrationResult> {
    return this.resolveAdapter(provider).ensure(provider, options, execOptions);
  }

  private resolveAdapter(provider: Provider): McpRegistrationAdapter {
    const adapter = this.adapterFactory.getAdapter(provider.name);
    // HOME-global config providers (agy) take precedence: they default to
    // isMcpCli=true (no `mcpMode='project_config'`) but must NOT route to the CLI
    // adapter — there is no `agy mcp add`.
    if (isGlobalMcpConfigCapable(adapter)) return this.antigravity;
    return isMcpCli(adapter) ? this.cli : this.configFile;
  }
}
