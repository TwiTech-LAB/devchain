import {
  BadGatewayException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import * as jose from 'jose';
import { isJoseCode, isNetworkError, mapStoreTokensError } from './store-tokens-error';

/** Build an Error carrying a jose-style `.code` (the mapper keys off `.code`). */
function withCode(code: string, message = 'jose failure'): Error {
  return Object.assign(new Error(message), { code });
}

const BAD_TOKEN_MESSAGE = 'Invalid or expired access token';
const IDENTITY_MESSAGE =
  'Could not verify the access token because the cloud identity service is unavailable or misconfigured';
const PERSIST_MESSAGE = 'Failed to persist cloud session';

describe('mapStoreTokensError', () => {
  describe('400 BadRequestException — bad/expired/tampered token', () => {
    const codes = [
      'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
      'ERR_JWT_EXPIRED',
      'ERR_JWT_CLAIM_VALIDATION_FAILED',
      'ERR_JWS_INVALID',
      'ERR_JWT_INVALID',
      'ERR_JOSE_ALG_NOT_ALLOWED',
    ];

    it.each(codes)('maps jose code %s to 400', (code) => {
      const result = mapStoreTokensError(withCode(code));
      expect(result).toBeInstanceOf(BadRequestException);
      expect(result.getStatus()).toBe(400);
      expect(result.message).toBe(BAD_TOKEN_MESSAGE);
    });

    it("maps a message containing 'JWT' to 400", () => {
      const result = mapStoreTokensError(new Error('signature did not match JWT'));
      expect(result).toBeInstanceOf(BadRequestException);
      expect(result.getStatus()).toBe(400);
      expect(result.message).toBe(BAD_TOKEN_MESSAGE);
    });
  });

  describe('502 BadGatewayException — identity/JWKS/JOSE infrastructure', () => {
    const codes = [
      'ERR_JWKS_NO_MATCHING_KEY',
      'ERR_JWKS_TIMEOUT',
      'ERR_JWKS_INVALID',
      'ERR_JWK_INVALID',
      'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
      'ERR_JOSE_NOT_SUPPORTED',
    ];

    it.each(codes)('maps jose code %s to 502', (code) => {
      const result = mapStoreTokensError(withCode(code));
      expect(result).toBeInstanceOf(BadGatewayException);
      expect(result.getStatus()).toBe(502);
      expect(result.message).toBe(IDENTITY_MESSAGE);
    });

    it("maps a 'JWKS fetch failed' message to 502", () => {
      const result = mapStoreTokensError(new Error('JWKS fetch failed: 500'));
      expect(result).toBeInstanceOf(BadGatewayException);
      expect(result.getStatus()).toBe(502);
      expect(result.message).toBe(IDENTITY_MESSAGE);
    });

    it('maps a network error with nested cause.code to 502', () => {
      const error = {
        name: 'TypeError',
        message: 'fetch failed',
        cause: { code: 'ECONNREFUSED' },
      };
      const result = mapStoreTokensError(error);
      expect(result).toBeInstanceOf(BadGatewayException);
      expect(result.getStatus()).toBe(502);
      expect(result.message).toBe(IDENTITY_MESSAGE);
    });

    it('maps a SyntaxError (malformed JWKS JSON) to 502', () => {
      const result = mapStoreTokensError(new SyntaxError('Unexpected token < in JSON'));
      expect(result).toBeInstanceOf(BadGatewayException);
      expect(result.getStatus()).toBe(502);
      expect(result.message).toBe(IDENTITY_MESSAGE);
    });

    it('maps an unknown jose error (JOSEError subclass) to 502', () => {
      const result = mapStoreTokensError(new jose.errors.JOSEError('something unexpected'));
      expect(result).toBeInstanceOf(BadGatewayException);
      expect(result.getStatus()).toBe(502);
      expect(result.message).toBe(IDENTITY_MESSAGE);
    });
  });

  describe('500 InternalServerErrorException — local persistence/unknown', () => {
    it('maps a non-jose unknown Error to 500 (e.g. tokenStore.store failure)', () => {
      const result = mapStoreTokensError(new Error('encryption key unavailable'));
      expect(result).toBeInstanceOf(InternalServerErrorException);
      expect(result.getStatus()).toBe(500);
      expect(result.message).toBe(PERSIST_MESSAGE);
    });
  });
});

describe('isJoseCode', () => {
  it('returns true when .code is in the list', () => {
    expect(isJoseCode(withCode('ERR_JWT_EXPIRED'), ['ERR_JWT_EXPIRED'])).toBe(true);
  });

  it('returns false when .code is absent or not in the list', () => {
    expect(isJoseCode(new Error('no code'), ['ERR_JWT_EXPIRED'])).toBe(false);
    expect(isJoseCode(withCode('ERR_OTHER'), ['ERR_JWT_EXPIRED'])).toBe(false);
  });
});

describe('isNetworkError', () => {
  it('detects a top-level network .code', () => {
    expect(isNetworkError(withCode('ENOTFOUND'))).toBe(true);
  });

  it('detects a nested cause.code', () => {
    expect(isNetworkError({ message: 'fetch failed', cause: { code: 'EAI_AGAIN' } })).toBe(true);
  });

  it("detects the 'fetch failed' message fallback", () => {
    expect(isNetworkError(new Error('fetch failed'))).toBe(true);
  });

  it('returns false for non-network errors', () => {
    expect(isNetworkError(new Error('boom'))).toBe(false);
    expect(isNetworkError(withCode('ERR_JWT_EXPIRED'))).toBe(false);
  });
});
