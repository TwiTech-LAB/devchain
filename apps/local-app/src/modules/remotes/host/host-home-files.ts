import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Stored Claude credentials win over `CLAUDE_CODE_OAUTH_TOKEN`, and the TLS
 * files are the VM identity home pins; the bootstrap refuses them too.
 */
export const REFUSED_FILES = [
  '.claude/.credentials.json',
  '.devchain/host.env',
  '.devchain/tls/key.pem',
  '.devchain/tls/cert.pem',
];

/** The Claude settings file the provider baseline writes, relative to home. */
export const CLAUDE_SETTINGS_FILE = '.claude/settings.json';

/** The key file the host SSH key routes write, relative to home. */
export const SSH_DIRECTORY = '.ssh';
export const AUTHORIZED_KEYS_FILE = 'authorized_keys';

/** Devin's own path rule: `$XDG_CONFIG_HOME/devin/config.json`, else `~/.config/devin/config.json`. */
export function getDevinUserConfigPath(home: string = homedir()): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(home, '.config');
  return join(configHome, 'devin', 'config.json');
}
