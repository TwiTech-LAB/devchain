import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHostCliVersions } from './host-cli-versions';

describe('readHostCliVersions', () => {
  it('reports the five versions in a host claim record and tolerates older records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devchain-runtime-'));
    const file = join(dir, 'claim.json');
    try {
      writeFileSync(file, JSON.stringify({ version: '0.25.0' }));
      expect(readHostCliVersions(file)).toBeNull();
      const cliVersions = {
        claude: '2.1.281',
        codex: '0.156.1',
        copilot: '1.0.88',
        opencode: '1.18.32',
        agy: 'agy 1.0.0',
      };
      writeFileSync(file, JSON.stringify({ version: '0.25.0', cliVersions }));
      expect(readHostCliVersions(file)).toEqual(cliVersions);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
