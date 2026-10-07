// Mock the logger BEFORE importing the controller: createLogger returns a pino
// child that is silent under Jest, so we swap in an inspectable mock instead.
const mockLogger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => mockLogger,
}));

import { BadRequestException, HttpException } from '@nestjs/common';
import { AuthCallbackController } from './auth-callback.controller';
import type { CloudSessionManagerService } from '../services/cloud-session-manager.service';

function withCode(code: string, message = 'jose failure'): Error {
  return Object.assign(new Error(message), { code });
}

describe('AuthCallbackController.storeTokens', () => {
  let controller: AuthCallbackController;
  let storeTokens: jest.Mock;

  const validBody = { accessToken: 'access', refreshToken: 'refresh' };

  beforeEach(() => {
    jest.clearAllMocks();
    storeTokens = jest.fn();
    const cloudSessionManager = {
      storeTokens,
    } as unknown as CloudSessionManagerService;
    controller = new AuthCallbackController(cloudSessionManager);
  });

  it('maps a bad token to 400 and logs the underlying error', async () => {
    const underlying = withCode('ERR_JWS_SIGNATURE_VERIFICATION_FAILED');
    storeTokens.mockRejectedValue(underlying);

    await expect(controller.storeTokens(validBody)).rejects.toBeInstanceOf(BadRequestException);

    expect(mockLogger.error).toHaveBeenCalledWith({ err: underlying }, 'storeTokens failed');
  });

  it('rejects an invalid body with a Zod 400 before the try (mapper not used, no error log)', async () => {
    let caught: unknown;
    try {
      await controller.storeTokens({ accessToken: '' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as HttpException).getStatus()).toBe(400);
    expect(storeTokens).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});
