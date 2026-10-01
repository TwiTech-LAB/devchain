/**
 * Parsing of Proxmox clone-generated identity from QEMU config.
 *
 * A full clone receives a fresh SMBIOS UUID (`smbios1` carries it as
 * `uuid=<value>,…`). That UUID is the durable generated identity of the
 * remote VM: unlike the numeric VMID it cannot be reused by an external
 * replacement, and unlike description/notes it is not operator-editable.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Extracts and validates the smbios1 UUID, lowercased; null when absent/invalid. */
export function parseSmbiosUuid(
  config: Record<string, unknown>,
): string | null {
  const raw = config["smbios1"];
  if (typeof raw !== "string") {
    return null;
  }
  const entry = raw
    .split(",")
    .map((part) => part.trim())
    .find((part) => part.startsWith("uuid="));
  if (!entry) {
    return null;
  }
  const value = entry.slice("uuid=".length).trim().toLowerCase();
  return UUID_PATTERN.test(value) ? value : null;
}

/** True when the config description carries the exact clone marker. */
export function configCarriesCloneMarker(
  config: Record<string, unknown>,
  marker: string,
): boolean {
  const description =
    typeof config["description"] === "string" ? config["description"] : "";
  return description.includes(marker);
}

/**
 * The config's unresolved-work lock ('clone' while PVE is still copying
 * disks, 'create'/'migrate'/… for other in-flight work); null when unlocked.
 * A present lock means the config is mid-write — correlation evidence read
 * from it is real, completion evidence is not.
 */
export function configLock(config: Record<string, unknown>): string | null {
  const lock = config["lock"];
  return typeof lock === "string" && lock.length > 0 ? lock : null;
}
