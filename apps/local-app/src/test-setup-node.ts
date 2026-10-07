/**
 * Lightweight test setup for backend (node environment) tests.
 * Does NOT import @testing-library/jest-dom to reduce memory overhead.
 */
import { Logger } from '@nestjs/common';
import { resetEnvConfig } from './common/config/env.config';

// Silence NestJS Logger.error output during tests to keep logs readable.
// Scoped handle avoids clobbering per-test prototype spies in other specs.
let loggerErrorSpy: jest.SpyInstance;
beforeEach(() => {
  loggerErrorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
});
afterEach(() => {
  loggerErrorSpy.mockRestore();
});

// On a claimed VM the real claim file would make every test app a host, and a host
// installs provider CLIs into the test's data folder. Checks off also keeps test apps
// off the npm registry, including tests that write their own claim file. Blank TLS
// paths are unset, so the VM's own certificate puts no TLS front on test apps.
// Startup skill sync off keeps test apps off GitHub and out of this machine's temp folder.
const BACKEND_TEST_ENV = {
  DEVCHAIN_HOST_ETC_DIR: '/nonexistent/devchain-host',
  PROVIDER_CLI_CHECKS_ENABLED: 'false',
  SKILLS_STARTUP_SYNC_ENABLED: 'false',
  DEVCHAIN_HOST_TLS_KEY_FILE: '',
  DEVCHAIN_HOST_TLS_CERT_FILE: '',
};

function applyBackendTestEnvIsolation(): void {
  // Stabilize env-dependent config for backend tests regardless of host shell values:
  // a shell HOST such as 0.0.0.0 would move every test server off loopback.
  process.env.PORT = '3000';
  delete process.env.HOST;
  // Refill only what a test deleted: a test that sets its own folder or flag keeps it.
  for (const [name, value] of Object.entries(BACKEND_TEST_ENV)) process.env[name] ??= value;
  resetEnvConfig();
}

// At load, override the shell and .env: tests never inherit this machine's host identity.
Object.assign(process.env, BACKEND_TEST_ENV);
applyBackendTestEnvIsolation();

beforeEach(() => {
  applyBackendTestEnvIsolation();
});

afterEach(() => {
  applyBackendTestEnvIsolation();
});

// Polyfill setImmediate for libraries (e.g., pino/thread-stream) in Jest environment
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!(global as any).setImmediate) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).setImmediate = (fn: (...args: any[]) => void, ...args: any[]) =>
    setTimeout(fn, 0, ...args);
}
