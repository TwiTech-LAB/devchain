import type { ExecutionContext } from '@nestjs/common';
import { resetEnvConfig } from '../config/env.config';
import { ForbiddenError } from '../errors/error-types';
import { IntegrationAdmissionGuard } from './integration-admission.guard';

describe('IntegrationAdmissionGuard', () => {
  const originalEnv = process.env;
  const context = {} as ExecutionContext;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DEVCHAIN_MODE;
    delete process.env.CONTAINER_PROJECT_ID;
    delete process.env.HOST;
    resetEnvConfig();
  });

  afterAll(() => {
    process.env = originalEnv;
    resetEnvConfig();
  });

  it('allows integration endpoints on a loopback main runtime', () => {
    expect(new IntegrationAdmissionGuard().canActivate(context)).toBe(true);
  });

  it('rejects integration endpoints on child runtimes', () => {
    process.env.CONTAINER_PROJECT_ID = '11111111-1111-4111-8111-111111111111';
    resetEnvConfig();

    expect(() => new IntegrationAdmissionGuard().canActivate(context)).toThrow(ForbiddenError);
  });

  it('rejects integration endpoints on non-loopback runtimes', () => {
    process.env.HOST = '0.0.0.0';
    resetEnvConfig();

    expect(() => new IntegrationAdmissionGuard().canActivate(context)).toThrow(ForbiddenError);
  });
});
