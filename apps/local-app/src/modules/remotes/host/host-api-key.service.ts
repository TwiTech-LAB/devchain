import { Injectable } from '@nestjs/common';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { getEnvConfig } from '../../../common/config/env.config';
import { isLoopbackHost } from '../../../common/config/integration-admission';
import {
  guardBrowserRequest,
  type BrowserRequestRefusal,
} from '../../../common/http/browser-request-guard';
import { AppError, IOError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import {
  HOST_API_KEY_PATTERN,
  HOST_API_KEY_REJECTED,
  hashHostApiKey,
  isClaimedHost,
} from '../host-api-key';

const logger = createLogger('HostApiKeyService');
export const HOST_API_KEY_REJECTION = {
  statusCode: 401,
  code: HOST_API_KEY_REJECTED,
  message: 'Host API key rejected',
} as const;

export type HostAdmissionRefusal = BrowserRequestRefusal | typeof HOST_API_KEY_REJECTION;

type ClaimedWithKey = { claimed: true; keyPath: string };
type Claim = { claimed: false } | { claimed: true; keyPath: string | null };
type CachedKey = { path: string; mtime: number; size: number; ino: number; digest: Buffer };

@Injectable()
export class HostApiKeyService {
  private cachedKey?: CachedKey;

  allows(
    request: IncomingMessage,
    transport: 'http' | 'socket',
    requireKey = false,
  ): HostAdmissionRefusal | null {
    const claim = this.readClaim();
    if (!claim.claimed) {
      // A wildcard HOST is an IP literal, which the guard admits anyway.
      const env = getEnvConfig();
      const refusal = guardBrowserRequest(request.headers, request.url ?? '', request.method, [
        ...env.ALLOWED_HOSTS,
        env.HOST,
      ]);
      if (refusal) {
        this.logRejection(request, refusal);
        return refusal;
      }
    }
    if (!requireKey) {
      if (!claim.claimed) return null;
      if (isLoopbackHost(request.socket.remoteAddress ?? '')) return null;
      if (
        transport === 'http' &&
        request.method === 'GET' &&
        this.path(request) === '/api/runtime'
      ) {
        return null;
      }
    }
    if (this.holdsKey(claim, request)) return null;
    this.logRejection(request, HOST_API_KEY_REJECTION);
    return HOST_API_KEY_REJECTION;
  }

  rotate(request: IncomingMessage, sha256: string): void {
    const claim = this.readClaim();
    if (!this.holdsKey(claim, request)) {
      this.logRejection(request, HOST_API_KEY_REJECTION);
      const { message, code, statusCode } = HOST_API_KEY_REJECTION;
      throw new AppError(message, code, statusCode);
    }
    const { keyPath } = claim;
    const temp = `${keyPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${sha256}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temp, keyPath);
      this.cachedKey = undefined;
    } catch {
      throw new IOError('Could not replace the host API key');
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        // A successful rename consumes the temporary file.
      }
    }
  }

  private holdsKey(claim: Claim, request: IncomingMessage): claim is ClaimedWithKey {
    return (
      claim.claimed &&
      claim.keyPath !== null &&
      this.matches(request.headers.authorization, claim.keyPath)
    );
  }

  private logRejection(request: IncomingMessage, refusal: HostAdmissionRefusal): void {
    logger.warn(
      {
        peer: request.socket.remoteAddress,
        method: request.method,
        path: this.path(request),
        origin: request.headers.origin,
        host: request.headers.host,
        code: refusal.code,
      },
      refusal.message,
    );
  }

  private path(request: IncomingMessage): string {
    return (request.url ?? '').split('?', 1)[0];
  }

  private readClaim(): Claim {
    const etcDir = getEnvConfig().DEVCHAIN_HOST_ETC_DIR;
    if (!isClaimedHost(etcDir)) return { claimed: false };
    try {
      const claim: unknown = JSON.parse(readFileSync(join(etcDir, 'claim.json'), 'utf8'));
      if (
        typeof claim === 'object' &&
        claim !== null &&
        'homePath' in claim &&
        typeof claim.homePath === 'string' &&
        isAbsolute(claim.homePath)
      ) {
        return { claimed: true, keyPath: join(claim.homePath, '.devchain', 'host-api-key') };
      }
    } catch {
      // An unreadable or malformed claim must not turn off host admission.
    }
    return { claimed: true, keyPath: null };
  }

  private matches(authorization: string | undefined, path: string): boolean {
    const digest = this.readDigest(path);
    // The scheme is case-insensitive; the key itself is not.
    const token = /^Bearer (.*)$/i.exec(authorization ?? '')?.[1];
    if (!digest || !token || !HOST_API_KEY_PATTERN.test(token)) return false;
    return timingSafeEqual(digest, Buffer.from(hashHostApiKey(token), 'hex'));
  }

  private readDigest(path: string): Buffer | null {
    try {
      const stat = statSync(path);
      const cached = this.cachedKey;
      if (
        cached &&
        cached.path === path &&
        cached.mtime === stat.mtimeMs &&
        cached.size === stat.size &&
        cached.ino === stat.ino
      )
        return cached.digest;
      this.cachedKey = undefined;
      if (!stat.isFile() || stat.size !== 65) return null;
      const content = readFileSync(path, 'utf8');
      if (!/^[a-f0-9]{64}\n$/.test(content)) return null;
      const digest = Buffer.from(content.slice(0, 64), 'hex');
      this.cachedKey = { path, mtime: stat.mtimeMs, size: stat.size, ino: stat.ino, digest };
      return digest;
    } catch {
      this.cachedKey = undefined;
      return null;
    }
  }
}
