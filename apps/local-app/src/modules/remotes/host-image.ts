import * as semver from 'semver';

/** Older images can create a default account that occupies the home user's ids. */
export const MIN_HOST_IMAGE_VERSION = '1.4.0';

/**
 * Whether this DevChain can claim an installer that reports this image version.
 * Prereleases of the minimum count too, so LAN builds (`1.4.0-lan.<id>`) pass.
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
