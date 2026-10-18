import {
  applyProviderCliNoUpdate,
  type ProviderCliNoUpdateCommand,
} from '../adapters/provider-cli-policy';
import { Inject, Injectable } from '@nestjs/common';
import { IOError, TimeoutError, ValidationError } from '../../../common/errors/error-types';
import { resolveBinary } from '../../../common/resolve-binary';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type { Provider } from '../../storage/models/domain.models';
import { createLogger } from '../../../common/logging/logger';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { ProviderAdapterFactory } from '../adapters/provider-adapter.factory';
import {
  isProviderPluginCapable,
  type ProviderPluginCatalogResult,
  type ProviderPluginCatalogSource,
} from '../adapters/capabilities/type-guards';
import type {
  ProviderPluginCatalogDto,
  ProviderPluginDto,
  ProviderPluginInstallDto,
} from '../dtos/provider-plugin.dto';
import { CodexAppServerClient } from './codex-app-server.client';

const logger = createLogger('ProviderPluginsService');

const CATALOG_TTL_MS = 10_000;
const PLUGIN_COMMAND_TIMEOUT_MS = 60_000;
/** Claude Code 2.1.302 lists its built-in plugin directory too: about 2.3 MB of JSON. */
const PLUGIN_COMMAND_MAX_BYTES = 16 * 1024 * 1024;
/** Codex `plugin/list` returns the remote catalog with descriptions: about 16 MB in one line. */
const APP_SERVER_CATALOG_MAX_BYTES = 64 * 1024 * 1024;
const MAX_PLUGIN_ID_LENGTH = 512;
const ASCII_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

interface ProviderCatalogCacheEntry {
  expiresAt: number;
  items: ProviderPluginDto[];
}

@Injectable()
export class ProviderPluginsService {
  private readonly catalogCache = new Map<string, ProviderCatalogCacheEntry>();

  constructor(
    @Inject(STORAGE_SERVICE)
    private readonly storage: Pick<StorageService, 'getProvider' | 'listProviders'>,
    private readonly adapterFactory: ProviderAdapterFactory,
    private readonly executor: ProcessExecutor,
    private readonly appServer: CodexAppServerClient,
  ) {}

  async listCatalog(options: { refresh?: boolean } = {}): Promise<ProviderPluginCatalogDto> {
    const providers = await this.storage.listProviders({ limit: 1_000, offset: 0 });
    const pluginProviders = providers.items.filter((provider) =>
      this.hasProviderPluginCapability(provider),
    );
    const entries = await Promise.all(
      pluginProviders.map((provider) =>
        this.listProviderCatalog(provider, options.refresh === true),
      ),
    );
    const items = entries
      .flat()
      .sort(
        (left, right) =>
          left.providerName.localeCompare(right.providerName) ||
          (left.marketplaceName ?? '').localeCompare(right.marketplaceName ?? '') ||
          left.name.localeCompare(right.name),
      );

    return { items, total: items.length };
  }

  async refreshCatalog(): Promise<ProviderPluginCatalogDto> {
    this.catalogCache.clear();
    return this.listCatalog({ refresh: true });
  }

  async install(providerId: string, pluginId: string): Promise<ProviderPluginInstallDto> {
    const normalizedPluginId = this.normalizePluginId(pluginId);
    const provider = await this.storage.getProvider(providerId);
    const adapter = this.adapterFactory.getAdapter(provider.name);
    if (!isProviderPluginCapable(adapter)) {
      throw new ValidationError(`Provider ${provider.name} does not support plugin installation`, {
        providerId,
      });
    }

    const binaryPath = await this.resolveProviderBinary(provider);
    const command = applyProviderCliNoUpdate(
      provider.name,
      [binaryPath, ...adapter.installProviderPlugin(normalizedPluginId)],
      process.env,
    );
    const result = await this.executor.run({
      argv: command.argv,
      env: command.env,
      mode: 'pipe',
      timeout: PLUGIN_COMMAND_TIMEOUT_MS,
      outputLimits: { maxBytes: PLUGIN_COMMAND_MAX_BYTES },
    });
    this.assertCommandSucceeded(result, provider, 'installation');
    this.catalogCache.delete(provider.id);

    return {
      success: true,
      providerId: provider.id,
      providerName: provider.name,
      pluginId: normalizedPluginId,
    };
  }

  private async listProviderCatalog(
    provider: Provider,
    refresh: boolean,
  ): Promise<ProviderPluginDto[]> {
    const cached = this.catalogCache.get(provider.id);
    if (!refresh && cached && cached.expiresAt > Date.now()) {
      return cached.items;
    }

    const adapter = this.adapterFactory.getAdapter(provider.name);
    if (!isProviderPluginCapable(adapter)) {
      throw new ValidationError(`Provider ${provider.name} does not support plugin catalogs`, {
        providerId: provider.id,
      });
    }

    const binaryPath = await this.resolveProviderBinary(provider);
    const source = adapter.providerPluginCatalog();
    const command = applyProviderCliNoUpdate(
      provider.name,
      [binaryPath, ...source.args],
      process.env,
    );
    const parsed = await this.readCatalog(provider, source, command);
    if (parsed.warnings.length > 0) {
      logger.warn(
        { providerId: provider.id, warnings: parsed.warnings },
        `${provider.name} plugin catalog loaded with warnings`,
      );
    }

    const items = parsed.entries.map((entry) => ({
      ...entry,
      providerId: provider.id,
      providerName: provider.name,
    }));
    this.catalogCache.set(provider.id, {
      expiresAt: Date.now() + CATALOG_TTL_MS,
      items,
    });
    return items;
  }

  private async readCatalog(
    provider: Provider,
    source: ProviderPluginCatalogSource,
    command: ProviderCliNoUpdateCommand,
  ): Promise<ProviderPluginCatalogResult> {
    if (source.transport === 'app-server') {
      const result = await this.appServer.request({
        argv: command.argv,
        env: command.env,
        method: source.method,
        params: source.params,
        timeoutMs: PLUGIN_COMMAND_TIMEOUT_MS,
        maxOutputBytes: APP_SERVER_CATALOG_MAX_BYTES,
      });
      return this.parseCatalog(provider, () => source.parse(result));
    }

    const result = await this.executor.run({
      argv: command.argv,
      env: command.env,
      mode: 'pipe',
      timeout: PLUGIN_COMMAND_TIMEOUT_MS,
      outputLimits: { maxBytes: PLUGIN_COMMAND_MAX_BYTES },
    });
    this.assertCommandSucceeded(result, provider, 'catalog');
    return this.parseCatalog(provider, () => source.parse(result.stdout));
  }

  private parseCatalog(
    provider: Provider,
    parse: () => ProviderPluginCatalogResult,
  ): ProviderPluginCatalogResult {
    try {
      return parse();
    } catch (error) {
      throw new IOError(`Unable to parse ${provider.name} plugin catalog`, {
        providerId: provider.id,
        cause: error instanceof Error ? error.message : 'Unknown parser error',
      });
    }
  }

  private hasProviderPluginCapability(provider: Provider): boolean {
    if (!this.adapterFactory.isSupported(provider.name)) {
      return false;
    }
    return isProviderPluginCapable(this.adapterFactory.getAdapter(provider.name));
  }

  private async resolveProviderBinary(provider: Provider): Promise<string> {
    const candidate = provider.binPath ?? provider.name;
    const binaryPath = await resolveBinary(candidate, this.executor);
    if (!binaryPath) {
      throw new IOError(`Unable to resolve plugin provider binary for ${provider.name}`, {
        providerId: provider.id,
      });
    }
    return binaryPath;
  }

  private assertCommandSucceeded(
    result: Awaited<ReturnType<ProcessExecutor['run']>>,
    provider: Provider,
    operation: 'catalog' | 'installation',
  ): void {
    if (result.timedOut) {
      throw new TimeoutError(`${provider.name} plugin ${operation} timed out`, {
        providerId: provider.id,
      });
    }
    if (operation === 'catalog' && result.truncated) {
      throw new IOError(`${provider.name} plugin ${operation} output exceeded the size limit`, {
        providerId: provider.id,
      });
    }
    if (!result.success) {
      throw new IOError(`${provider.name} plugin ${operation} failed`, {
        providerId: provider.id,
        exitCode: result.exitCode,
      });
    }
  }

  private normalizePluginId(pluginId: string): string {
    const normalized = pluginId.trim();
    if (
      normalized.length === 0 ||
      normalized.length > MAX_PLUGIN_ID_LENGTH ||
      ASCII_CONTROL_PATTERN.test(normalized)
    ) {
      throw new ValidationError(
        'Plugin ID must contain 1 to 512 characters and no ASCII control characters.',
        { field: 'pluginId' },
      );
    }
    return normalized;
  }
}
