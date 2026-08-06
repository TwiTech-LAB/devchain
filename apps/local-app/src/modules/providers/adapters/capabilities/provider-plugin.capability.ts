import type { ProviderPluginCatalogEntry } from '../../dtos/provider-plugin.dto';

export interface ProviderPluginCapability {
  listProviderPlugins(): string[];
  installProviderPlugin(pluginId: string): string[];
  parseProviderPluginCatalog(stdout: string): ProviderPluginCatalogEntry[];
}
