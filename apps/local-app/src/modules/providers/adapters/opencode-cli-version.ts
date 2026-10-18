import { ValidationError } from '../../../common/errors/error-types';

const SUPPORTED_OPENCODE_MAJORS = [1, 2] as const;

type OpencodeMajor = (typeof SUPPORTED_OPENCODE_MAJORS)[number];

export interface OpencodeCliVersion {
  raw: string;
  major: OpencodeMajor;
}

/** Accepts `1.18.32` (v1) and `opencode v2.0.31` (v2); null when unparseable. */
export function parseOpencodeCliVersion(raw: string): { raw: string; major: number } | null {
  const trimmed = raw.trim();
  const match = /^(?:opencode\s+)?v?(\d+)\.\d+\.\d+/i.exec(trimmed);
  return match ? { raw: trimmed, major: Number(match[1]) } : null;
}

/** True only for a 2.x version string; any other or unparseable version is not OpenCode 2. */
export function isOpencodeV2(raw: string): boolean {
  return parseOpencodeCliVersion(raw)?.major === 2;
}

export function assertSupportedOpencodeVersion(raw: string, binPath: string): OpencodeCliVersion {
  const parsed = parseOpencodeCliVersion(raw);
  const major = SUPPORTED_OPENCODE_MAJORS.find((supported) => supported === parsed?.major);
  if (!parsed || major === undefined) {
    throw new ValidationError(
      `Unsupported OpenCode version '${raw.trim()}' at ${binPath}. DevChain supports OpenCode 1.x and 2.x.`,
      { reason: 'unsupported_opencode_version', binPath },
    );
  }
  return { raw: parsed.raw, major };
}
