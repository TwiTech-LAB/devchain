const cliModule = jest.requireActual('../../../../scripts/cli.js') as {
  __test__: {
    applyContainerModeDefaults: (
      containerMode: boolean,
      opts?: { port?: number | string | null },
      env?: Record<string, string | undefined>,
    ) => void;
    getDevUiConfig: (containerMode: boolean) => {
      script: string;
      startMessage: string;
      logLabel: string;
      url: string;
    };
    getDevModeSpawnConfig: (input: {
      containerMode: boolean;
      port: number;
      env?: Record<string, string | undefined>;
    }) => {
      vite: {
        args: string[];
        env: Record<string, string | undefined>;
      };
    };
  };
};

describe('CLI Phase 12 container mode wiring', () => {
  it('sets default port in orchestration mode without mutating DEVCHAIN_MODE', () => {
    const env: Record<string, string | undefined> = {};

    cliModule.__test__.applyContainerModeDefaults(true, {}, env);

    expect(env.DEVCHAIN_MODE).toBeUndefined();
    expect(env.PORT).toBe('3000');
  });

  it('does not override explicit non-default port in orchestration mode', () => {
    const env: Record<string, string | undefined> = {
      PORT: '4100',
    };

    cliModule.__test__.applyContainerModeDefaults(true, {}, env);

    expect(env.DEVCHAIN_MODE).toBeUndefined();
    expect(env.PORT).toBe('4100');
  });

  it('uses normal UI dev script in container mode and wires VITE_API_PORT', () => {
    const uiConfig = cliModule.__test__.getDevUiConfig(true);
    const spawnConfig = cliModule.__test__.getDevModeSpawnConfig({
      containerMode: true,
      port: 3000,
      env: {},
    });

    expect(uiConfig.script).toBe('dev:ui');
    expect(uiConfig.url).toBe('http://127.0.0.1:5175');
    expect(spawnConfig.vite.args).toEqual(['--filter', 'local-app', 'dev:ui']);
    expect(spawnConfig.vite.env.VITE_API_PORT).toBe('3000');
  });

  it('does not mutate env when container mode is disabled', () => {
    const env: Record<string, string | undefined> = {};

    cliModule.__test__.applyContainerModeDefaults(false, {}, env);

    expect(env.DEVCHAIN_MODE).toBeUndefined();
    expect(env.PORT).toBeUndefined();
  });
});
