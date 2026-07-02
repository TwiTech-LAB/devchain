import * as os from 'os';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { CopilotAuthProbeService, COPILOT_AUTH_REMEDIATION } from './copilot-auth-probe.service';

jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return { ...actual, homedir: jest.fn(() => actual.homedir()) };
});

const JSONC_HEADER =
  '// User settings belong in settings.json.\n// This file is managed automatically.';

describe('CopilotAuthProbeService', () => {
  let home: string;
  let service: CopilotAuthProbeService;

  const configPath = () => join(home, '.copilot', 'config.json');
  const writeConfig = async (value: string) => {
    await mkdir(dirname(configPath()), { recursive: true });
    await writeFile(configPath(), value);
  };
  const emptyEnv: NodeJS.ProcessEnv = {};

  beforeEach(async () => {
    home = await mkdtemp(join(os.tmpdir(), 'copilot-auth-home-'));
    (os.homedir as jest.Mock).mockReturnValue(home);
    service = new CopilotAuthProbeService();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('exposes the actionable remediation string', () => {
    expect(COPILOT_AUTH_REMEDIATION).toContain('copilot login');
    expect(COPILOT_AUTH_REMEDIATION).toContain('COPILOT_GITHUB_TOKEN');
  });

  it.each(['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'])(
    'is authenticated when %s is set (no config needed)',
    async (key) => {
      expect(await service.isAuthenticated({ [key]: 'tok' })).toBe(true);
    },
  );

  it('ignores blank/whitespace token env values', async () => {
    expect(await service.isAuthenticated({ GH_TOKEN: '   ' })).toBe(false);
  });

  it('is authenticated when loggedInUsers[] is non-empty (JSONC config)', async () => {
    await writeConfig(
      `${JSONC_HEADER}\n${JSON.stringify({ loggedInUsers: [{ login: 'octocat' }] }, null, 2)}\n`,
    );
    expect(await service.isAuthenticated(emptyEnv)).toBe(true);
  });

  it('is NOT authenticated when loggedInUsers[] is empty', async () => {
    await writeConfig(`${JSONC_HEADER}\n${JSON.stringify({ loggedInUsers: [] }, null, 2)}\n`);
    expect(await service.isAuthenticated(emptyEnv)).toBe(false);
  });

  it('is NOT authenticated when config is missing (ENOENT)', async () => {
    expect(await service.isAuthenticated(emptyEnv)).toBe(false);
  });

  it('is NOT authenticated when config is malformed (tolerated, no throw)', async () => {
    await writeConfig(`${JSONC_HEADER}\n{ not valid json `);
    expect(await service.isAuthenticated(emptyEnv)).toBe(false);
  });

  it('does not mis-parse a config whose values contain // (https URLs)', async () => {
    await writeConfig(
      `${JSONC_HEADER}\n${JSON.stringify(
        { loggedInUsers: [{ host: 'https://github.com', login: 'octocat' }] },
        null,
        2,
      )}\n`,
    );
    expect(await service.isAuthenticated(emptyEnv)).toBe(true);
  });
});
