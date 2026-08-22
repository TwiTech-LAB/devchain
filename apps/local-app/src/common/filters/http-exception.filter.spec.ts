import type { ArgumentsHost } from '@nestjs/common';
jest.mock('../logging/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  return { createLogger: () => logger, mockLogger: logger };
});

import { AllExceptionsFilter } from './http-exception.filter';

const { mockLogger } = jest.requireMock('../logging/logger') as {
  mockLogger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock };
};

describe('AllExceptionsFilter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not expose or log arbitrary Error messages and stacks', () => {
    const send = jest.fn();
    const code = jest.fn(() => ({ send }));
    const response = { sent: false, code };
    const request = { id: 'request-1', method: 'GET', url: '/api/integrations' };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => request,
      }),
    } as unknown as ArgumentsHost;
    const secret = 'vendor-body-with-token=top-secret';

    new AllExceptionsFilter().catch(new Error(secret), host);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 500,
        code: 'internal_error',
        message: 'Internal server error',
      }),
    );
    expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain(secret);
  });
});
