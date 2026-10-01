import hostImageSetting from './host-image.json';

export interface BuiltInHostImage {
  version: string;
  url: string;
  sha256: string;
}

export interface HostImageEnvironment {
  HOST_IMAGE_URL?: string;
  HOST_IMAGE_SHA256?: string;
}

export interface HostImageSource {
  version?: string;
  url: string;
  sha256: string;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function readBuiltInHostImage(value: unknown): BuiltInHostImage | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  if (
    !nonEmptyString(entry.version) ||
    !nonEmptyString(entry.url) ||
    !nonEmptyString(entry.sha256)
  ) {
    return null;
  }
  return { version: entry.version, url: entry.url, sha256: entry.sha256 };
}

export const BUILT_IN_HOST_IMAGE = readBuiltInHostImage(hostImageSetting);

export function selectHostImageSource(
  environment: HostImageEnvironment,
  builtInImage: BuiltInHostImage | null = BUILT_IN_HOST_IMAGE,
): HostImageSource | null {
  const { HOST_IMAGE_URL, HOST_IMAGE_SHA256 } = environment;
  if (HOST_IMAGE_URL !== undefined || HOST_IMAGE_SHA256 !== undefined) {
    if (!HOST_IMAGE_URL || !HOST_IMAGE_SHA256) return null;
    return { url: HOST_IMAGE_URL, sha256: HOST_IMAGE_SHA256 };
  }
  return builtInImage;
}
