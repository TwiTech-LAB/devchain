const PROXMOX_DNS_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';

export const PROXMOX_DNS_NAME_PATTERN = new RegExp(
  `^(?:${PROXMOX_DNS_LABEL})(?:\\.(?:${PROXMOX_DNS_LABEL}))*$`,
);

export function isProxmoxDnsName(value: string): boolean {
  return PROXMOX_DNS_NAME_PATTERN.test(value);
}
