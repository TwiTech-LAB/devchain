import { getEnvConfig, resetEnvConfig } from './env.config';

describe('env.config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DATABASE_URL;
    delete process.env.RUNTIME_TOKEN;
    delete process.env.DEVCHAIN_CLOUD_UI_ENABLED;
    resetEnvConfig();
  });

  afterAll(() => {
    process.env = originalEnv;
    resetEnvConfig();
  });

  it('enables Cloud UI features by default', () => {
    const config = getEnvConfig();

    expect(config.DEVCHAIN_CLOUD_UI_ENABLED).toBe(true);
  });

  it('enables Cloud UI features when DEVCHAIN_CLOUD_UI_ENABLED is empty (treated as unset)', () => {
    process.env.DEVCHAIN_CLOUD_UI_ENABLED = '';

    const config = getEnvConfig();

    expect(config.DEVCHAIN_CLOUD_UI_ENABLED).toBe(true);
  });

  it.each(['1', 'true', 'TRUE', 'yes', 'on'])(
    'enables Cloud UI features when DEVCHAIN_CLOUD_UI_ENABLED=%s',
    (value) => {
      process.env.DEVCHAIN_CLOUD_UI_ENABLED = value;

      const config = getEnvConfig();

      expect(config.DEVCHAIN_CLOUD_UI_ENABLED).toBe(true);
    },
  );

  it.each(['0', 'FALSE'])(
    'disables Cloud UI features when DEVCHAIN_CLOUD_UI_ENABLED=%s',
    (value) => {
      process.env.DEVCHAIN_CLOUD_UI_ENABLED = value;

      const config = getEnvConfig();

      expect(config.DEVCHAIN_CLOUD_UI_ENABLED).toBe(false);
    },
  );

  it('defaults REMOTES_HEALTH_INTERVAL_MS to 10 seconds', () => {
    delete process.env.REMOTES_HEALTH_INTERVAL_MS;

    const config = getEnvConfig();

    expect(config.REMOTES_HEALTH_INTERVAL_MS).toBe(10000);
  });

  it('parses a custom REMOTES_HEALTH_INTERVAL_MS', () => {
    process.env.REMOTES_HEALTH_INTERVAL_MS = '5000';

    const config = getEnvConfig();

    expect(config.REMOTES_HEALTH_INTERVAL_MS).toBe(5000);
  });

  it('ignores unknown environment keys such as a retired DEVCHAIN_MODE', () => {
    process.env.DEVCHAIN_MODE = 'main';

    const config = getEnvConfig() as Record<string, unknown>;

    expect(config.DEVCHAIN_MODE).toBeUndefined();
  });
});
