import * as semver from 'semver';

/** Image versions this DevChain can claim; older images serve no TLS certificate. */
export const MIN_HOST_IMAGE_VERSION = '1.3.0';

/**
 * Whether this DevChain can claim an installer that reports this image version.
 * Prereleases of the minimum count too, so LAN builds (`1.3.0-lan.<id>`) pass.
 */
export function isSupportedHostImage(imageVersion: string | null | undefined): boolean {
  return (
    Boolean(imageVersion) &&
    semver.valid(imageVersion) !== null &&
    semver.gte(imageVersion!, `${MIN_HOST_IMAGE_VERSION}-0`)
  );
}

/** Why an installer image cannot be claimed. The claim and the address check both show it. */
export function unsupportedHostImageMessage(imageVersion: string | null): string {
  return `Host image ${imageVersion ?? 'unknown'} is not supported; ${MIN_HOST_IMAGE_VERSION} or later is needed.`;
}
