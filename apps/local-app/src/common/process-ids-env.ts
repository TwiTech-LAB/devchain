export function processIdsEnv(): Record<string, string> {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    return {};
  }
  return {
    DEVCHAIN_UID: String(process.getuid()),
    DEVCHAIN_GID: String(process.getgid()),
  };
}
