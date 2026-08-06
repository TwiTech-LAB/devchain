export interface ProviderPluginCatalogEntry {
  pluginId: string;
  name: string;
  description: string | null;
  marketplaceName: string | null;
  version: string | null;
  installed: boolean;
  available: boolean;
  providerEnabled: boolean;
  installationScopes: string[];
  installCount: number | null;
  installPolicy: string | null;
  authPolicy: string | null;
}

export interface ProviderPluginDto extends ProviderPluginCatalogEntry {
  providerId: string;
  providerName: string;
}

export interface ProviderPluginCatalogDto {
  items: ProviderPluginDto[];
  total: number;
}

export interface ProviderPluginInstallDto {
  success: true;
  providerId: string;
  providerName: string;
  pluginId: string;
}
