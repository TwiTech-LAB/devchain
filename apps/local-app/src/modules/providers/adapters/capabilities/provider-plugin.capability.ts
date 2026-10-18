import type { ProviderPluginCatalogEntry } from '../../dtos/provider-plugin.dto';

export interface ProviderPluginCatalogResult {
  entries: ProviderPluginCatalogEntry[];
  /** Provider-reported problems that left part of the catalog out without failing it. */
  warnings: unknown[];
}

/** How a provider's plugin catalog is read; `args` follow the provider binary. */
export type ProviderPluginCatalogSource =
  | {
      transport: 'cli';
      args: string[];
      parse(stdout: string): ProviderPluginCatalogResult;
    }
  | {
      transport: 'app-server';
      args: string[];
      method: string;
      params: Record<string, unknown>;
      parse(result: unknown): ProviderPluginCatalogResult;
    };

export interface ProviderPluginCapability {
  providerPluginCatalog(): ProviderPluginCatalogSource;
  installProviderPlugin(pluginId: string): string[];
}
