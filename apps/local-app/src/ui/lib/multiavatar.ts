import multiavatar from '@multiavatar/multiavatar';

interface AvatarVersionOverride {
  part: string;
  theme: 'A' | 'B' | 'C';
}

export interface AgentAvatarOptions {
  /**
   * When true, removes the circular background ("environment") layer.
   */
  omitBackground?: boolean;
  /**
   * Optional override to force a specific avatar version.
   * See https://github.com/multiavatar/Multiavatar for details.
   */
  version?: AvatarVersionOverride;
}

interface AvatarCacheEntry {
  svg: string;
  dataUri: string;
}

const avatarCache = new Map<string, AvatarCacheEntry>();

function toDataUri(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function buildCacheKey(name: string, options?: AgentAvatarOptions): string {
  const normalizedOptions = options
    ? {
        omitBackground: !!options.omitBackground,
        version: options.version
          ? { part: options.version.part, theme: options.version.theme }
          : undefined,
      }
    : undefined;
  return JSON.stringify({
    name: name.toLowerCase(),
    options: normalizedOptions,
  });
}

function renderAvatarSvg(name: string, options?: AgentAvatarOptions): string {
  const omitBackground = options?.omitBackground ?? false;
  const version = options?.version
    ? { part: options.version.part, theme: options.version.theme }
    : undefined;
  return multiavatar(name, omitBackground, version);
}

function getOrCreateAvatarEntry(
  name: string | null | undefined,
  options?: AgentAvatarOptions,
): AvatarCacheEntry | null {
  const normalized = name?.trim();
  if (!normalized) {
    return null;
  }
  const cacheKey = buildCacheKey(normalized, options);
  const cached = avatarCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  try {
    const svg = renderAvatarSvg(normalized, options);
    const entry: AvatarCacheEntry = { svg, dataUri: toDataUri(svg) };
    avatarCache.set(cacheKey, entry);
    return entry;
  } catch {
    return null;
  }
}

export function getAgentAvatarSvg(
  name: string | null | undefined,
  options?: AgentAvatarOptions,
): string | null {
  const entry = getOrCreateAvatarEntry(name, options);
  return entry?.svg ?? null;
}

export function getAgentAvatarDataUri(
  name: string | null | undefined,
  options?: AgentAvatarOptions,
): string | null {
  const entry = getOrCreateAvatarEntry(name, options);
  return entry?.dataUri ?? null;
}

export function getAgentAvatarAltText(name: string | null | undefined): string {
  const normalized = name?.trim();
  if (!normalized) {
    return 'Agent avatar placeholder';
  }
  return `Avatar for agent ${normalized}`;
}

export function getAgentInitials(name: string | null | undefined): string {
  const normalized = name?.trim();
  if (!normalized) {
    return '??';
  }
  const [first = '', second = ''] = normalized.split(/\s+/);
  if (!second) {
    return first.charAt(0).toUpperCase();
  }
  return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
}

export function clearAvatarCache() {
  avatarCache.clear();
}
