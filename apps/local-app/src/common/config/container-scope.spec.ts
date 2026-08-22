import { ForbiddenError } from '../errors/error-types';
import {
  assertIntegrationAdmission,
  getContainerScopedProjectId,
  getIntegrationAdmission,
} from './container-scope';

describe('getContainerScopedProjectId', () => {
  const projectId = '11111111-1111-4111-8111-111111111111';

  it('returns the configured project only in normal mode', () => {
    expect(
      getContainerScopedProjectId({
        DEVCHAIN_MODE: 'normal',
        CONTAINER_PROJECT_ID: projectId,
      }),
    ).toBe(projectId);
  });

  it('returns null when normal mode has no container project', () => {
    expect(
      getContainerScopedProjectId({
        DEVCHAIN_MODE: 'normal',
        CONTAINER_PROJECT_ID: undefined,
      }),
    ).toBeNull();
  });

  it('ignores a container project in main mode', () => {
    expect(
      getContainerScopedProjectId({
        DEVCHAIN_MODE: 'main',
        CONTAINER_PROJECT_ID: projectId,
      }),
    ).toBeNull();
  });
});

describe('integration admission', () => {
  const projectId = '11111111-1111-4111-8111-111111111111';

  it.each(['127.0.0.1', '127.42.0.8', '::1', '[::1]', 'localhost'])(
    'allows loopback host %s in the main runtime',
    (host) => {
      expect(
        getIntegrationAdmission({
          DEVCHAIN_MODE: 'main',
          CONTAINER_PROJECT_ID: undefined,
          HOST: host,
        }),
      ).toEqual({ allowed: true, reason: null });
    },
  );

  it.each(['0.0.0.0', '::', '192.168.1.10', 'devchain.internal'])(
    'rejects non-loopback host %s',
    (host) => {
      expect(
        getIntegrationAdmission({
          DEVCHAIN_MODE: 'main',
          CONTAINER_PROJECT_ID: undefined,
          HOST: host,
        }),
      ).toEqual({ allowed: false, reason: 'non_loopback_host' });
    },
  );

  it('rejects a normal-mode child runtime before considering its loopback host', () => {
    expect(
      getIntegrationAdmission({
        DEVCHAIN_MODE: 'normal',
        CONTAINER_PROJECT_ID: projectId,
        HOST: '127.0.0.1',
      }),
    ).toEqual({ allowed: false, reason: 'child_runtime' });
  });

  it('preserves the main-mode CONTAINER_PROJECT_ID exemption', () => {
    expect(
      getIntegrationAdmission({
        DEVCHAIN_MODE: 'main',
        CONTAINER_PROJECT_ID: projectId,
        HOST: '127.0.0.1',
      }),
    ).toEqual({ allowed: true, reason: null });
  });

  it('throws a typed forbidden error when an integration operation is denied', () => {
    expect(() =>
      assertIntegrationAdmission({
        DEVCHAIN_MODE: 'normal',
        CONTAINER_PROJECT_ID: projectId,
        HOST: '127.0.0.1',
      }),
    ).toThrow(ForbiddenError);

    try {
      assertIntegrationAdmission({
        DEVCHAIN_MODE: 'normal',
        CONTAINER_PROJECT_ID: projectId,
        HOST: '127.0.0.1',
      });
    } catch (error) {
      expect(error).toMatchObject({
        statusCode: 403,
        details: { code: 'INTEGRATIONS_UNAVAILABLE', reason: 'child_runtime' },
      });
    }
  });
});
