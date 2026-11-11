import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '../..');
const SCRIPTS = join(SRC, '../../../scripts');

/** Names of the launch-time Vault delivery, which agents no longer get. */
const REMOVED = [
  'session_vault_grants',
  'sessionVaultGrants',
  'restart-needed',
  'restart_needed',
  'restartNeeded',
  'RestartToLoad',
  'shadowedVaultKeys',
  'shadowLabel',
  'vaultEnv',
  'vaultFiles',
  'replaceVaultSessionFiles',
  'VaultLaunchFile',
  'last_injected',
  'lastInjected',
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === '__tests__') return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js)$/.test(name) && path !== __filename ? [path] : [];
  });
}

// A text scan is the only layer that sees a name left in a string, a route or a comment.
describe('Vault launch cutover', () => {
  it('leaves no reference to launch-time Vault delivery in the app or CLI source', () => {
    const hits = [...sourceFiles(SRC), ...sourceFiles(SCRIPTS)].flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return REMOVED.filter((name) => text.includes(name)).map(
        (name) => `${relative(SRC, file)}: ${name}`,
      );
    });

    expect(hits).toEqual([]);
  });
});
