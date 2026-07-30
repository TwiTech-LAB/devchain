/**
 * Provider detection for the standalone CLI installer (scripts/cli.js).
 *
 * Project: cli-helpers (plain JS, no TS transform — see apps/local-app/package.json jest
 * `projects[].cli-helpers`). `child_process.execSync` (the primitive behind
 * `isBinaryInstalled`'s `which <cmd>` lookup) is mocked so the suite never shells out.
 *
 * Layer: unit (cheapest layer that proves `detectInstalledProviders` checks for and maps
 * each binary). Covers the `agy` parity (Antigravity) and `copilot` (GitHub Copilot CLI).
 */
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execSync: jest.fn(),
}));

const { execSync } = require('child_process');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __test__ } = require('../cli.js');

const { detectInstalledProviders } = __test__;

/**
 * Drive `isBinaryInstalled` by simulating `which <name>` results. Only the binaries present
 * in `installed` return a path; every other `which` call throws (mimicking "not found").
 */
function setInstalled(installed) {
  execSync.mockImplementation((cmd) => {
    for (const [name, path] of Object.entries(installed)) {
      if (cmd === `which ${name}`) return `${path}\n`;
    }
    throw new Error(`${cmd}: command not found`);
  });
}

describe('detectInstalledProviders', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('detects and maps agy to its absolute (trimmed) path', () => {
    setInstalled({ agy: '/usr/local/bin/agy' });
    const detected = detectInstalledProviders();
    expect(detected.get('agy')).toBe('/usr/local/bin/agy');
  });

  it('detects and maps copilot to its absolute (trimmed) path', () => {
    setInstalled({ copilot: '/usr/local/bin/copilot' });
    const detected = detectInstalledProviders();
    expect(detected.get('copilot')).toBe('/usr/local/bin/copilot');
  });

  it('detects all known providers when every binary is on PATH', () => {
    setInstalled({
      codex: '/usr/bin/codex',
      claude: '/usr/bin/claude',
      opencode: '/usr/bin/opencode',
      agy: '/usr/local/bin/agy',
      copilot: '/usr/local/bin/copilot',
    });
    const detected = detectInstalledProviders();
    expect(detected.size).toBe(5);
    expect(Array.from(detected.keys()).sort()).toEqual(
      ['agy', 'claude', 'codex', 'copilot', 'opencode'],
    );
  });

  it('does not detect the retired gemini binary even when it is on PATH', () => {
    setInstalled({ gemini: '/usr/bin/gemini', agy: '/usr/local/bin/agy' });
    const detected = detectInstalledProviders();
    expect(detected.has('gemini')).toBe(false);
    expect(detected.get('agy')).toBe('/usr/local/bin/agy');
    expect(detected.size).toBe(1);
  });

  it('omits copilot when it is not installed (only codex on PATH)', () => {
    setInstalled({ codex: '/usr/bin/codex' });
    const detected = detectInstalledProviders();
    expect(detected.has('copilot')).toBe(false);
    expect(detected.get('codex')).toBe('/usr/bin/codex');
    expect(detected.size).toBe(1);
  });

  it('returns an empty map when no provider binaries are installed', () => {
    setInstalled({});
    const detected = detectInstalledProviders();
    expect(detected.size).toBe(0);
  });
});
