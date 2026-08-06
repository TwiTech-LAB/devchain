type JsonRecord = Record<string, unknown>;

export interface ProviderPluginCatalogPayload {
  installed: JsonRecord[];
  available: JsonRecord[];
}

export function parseProviderPluginCatalogPayload(
  stdout: string,
  providerName: string,
): ProviderPluginCatalogPayload {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error(`${providerName} plugin catalog returned invalid JSON`);
  }

  if (!isRecord(value) || !Array.isArray(value.installed) || !Array.isArray(value.available)) {
    throw new Error(`${providerName} plugin catalog returned an invalid payload`);
  }

  return {
    installed: value.installed.map((entry, index) =>
      requireRecord(entry, `${providerName} installed plugin ${index}`),
    ),
    available: value.available.map((entry, index) =>
      requireRecord(entry, `${providerName} available plugin ${index}`),
    ),
  };
}

export function requireString(record: JsonRecord, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${context} is missing ${key}`);
  }
  return value;
}

export function optionalString(record: JsonRecord, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function optionalBoolean(record: JsonRecord, key: string): boolean {
  return record[key] === true;
}

export function optionalNumber(record: JsonRecord, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function parseQualifiedPluginId(pluginId: string): {
  name: string;
  marketplaceName: string | null;
} {
  const separator = pluginId.lastIndexOf('@');
  if (separator <= 0 || separator === pluginId.length - 1) {
    return { name: pluginId, marketplaceName: null };
  }
  return {
    name: pluginId.slice(0, separator),
    marketplaceName: pluginId.slice(separator + 1),
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, context: string): JsonRecord {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value;
}
