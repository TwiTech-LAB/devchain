import { spawnSync } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { resolve, join } from 'path';
import { CodexPluginProfileMaterializerService } from './codex-plugin-profile-materializer.service';

const codexVersion = spawnSync('codex', ['--version'], { encoding: 'utf8' });
const describeCodex0146 =
  codexVersion.status === 0 && codexVersion.stdout.trim() === 'codex-cli 0.146.0'
    ? describe
    : describe.skip;

describeCodex0146('Codex 0.146 plugin profile effect contract', () => {
  let codexHome: string;

  beforeEach(async () => {
    codexHome = await mkdtemp(join(tmpdir(), 'devchain-codex-profile-contract-'));
    const fixtureRoot = resolve(__dirname, '__fixtures__', 'codex-plugin-marketplace');
    runCodex(['plugin', 'marketplace', 'add', fixtureRoot, '--json']);
    runCodex(['plugin', 'add', 'profile-effect@devchain-contract', '--json']);
  });

  afterEach(async () => {
    await rm(codexHome, { recursive: true, force: true });
  });

  it('changes model-visible skills from enabled to disabled', async () => {
    const service = new CodexPluginProfileMaterializerService(join(codexHome, 'private'));
    const profile = service.serializePolicy([
      { pluginId: 'profile-effect@devchain-contract', enabled: false },
    ]);
    await writeFile(join(codexHome, 'devchain-disabled.config.toml'), profile);

    expect(runCodex(['debug', 'prompt-input'])).toContain('profile-effect');
    expect(runCodex(['--profile', 'devchain-disabled', 'debug', 'prompt-input'])).not.toContain(
      'profile-effect',
    );
  });

  it('changes model-visible skills from disabled to enabled without editing base bytes', async () => {
    const service = new CodexPluginProfileMaterializerService(join(codexHome, 'private'));
    const base = service.serializePolicy([
      { pluginId: 'profile-effect@devchain-contract', enabled: false },
    ]);
    const profile = service.serializePolicy([
      { pluginId: 'profile-effect@devchain-contract', enabled: true },
    ]);
    const basePath = join(codexHome, 'config.toml');
    await writeFile(basePath, base);
    await writeFile(join(codexHome, 'devchain-enabled.config.toml'), profile);

    expect(runCodex(['debug', 'prompt-input'])).not.toContain('profile-effect');
    expect(runCodex(['--profile', 'devchain-enabled', 'debug', 'prompt-input'])).toContain(
      'profile-effect',
    );
    expect(await readFile(basePath, 'utf8')).toBe(base);
  });

  function runCodex(args: string[]): string {
    const result = spawnSync('codex', args, {
      env: { ...process.env, CODEX_HOME: codexHome },
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`Codex contract command failed with status ${result.status}`);
    }
    return result.stdout;
  }
});
