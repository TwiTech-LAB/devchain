import { ArgumentsHost, Catch } from '@nestjs/common';
import type { WsExceptionFilter } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { AppError } from '../errors/error-types';
import { createLogger } from '../logging/logger';

const logger = createLogger('WsExceptionFilter');

/**
 * Global WebSocket exception filter.
 * Emits a standardized envelope on the shared 'message' channel so UI can handle uniformly.
 *
 * Note: We use @Catch() (catch-all) because we need to handle HttpExceptions thrown in WS context.
 * The filter explicitly checks host.getType() and re-throws for non-WS contexts to allow
 * the HTTP exception filter to handle those.
 */
@Catch()
export class AllWsExceptionsFilter implements WsExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    // Only handle WS context; re-throw for HTTP/RPC to be handled by their filters
    if (host.getType() !== 'ws') {
      throw exception; // Re-throw instead of returning to let HTTP filter handle it
    }

    const ws = host.switchToWs();
    const client = ws.getClient<Socket>();
    const data = ws.getData();

    let statusCode = 500;
    let code = 'ws_error';
    let message = 'WebSocket error';
    let details: Record<string, unknown> | undefined;

    if (exception instanceof AppError) {
      statusCode = exception.statusCode;
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof WsException) {
      const error = exception.getError();
      if (typeof error === 'string') {
        message = error;
      } else if (typeof error === 'object' && error) {
        const errObj = error as Record<string, unknown>;
        message = String(errObj.message ?? message);
        details = { ...details, ...errObj };
      }
    } else if (
      typeof exception === 'object' &&
      exception !== null &&
      'getStatus' in exception &&
      typeof (exception as { getStatus?: unknown }).getStatus === 'function'
    ) {
      // Support HttpException thrown in WS context
      try {
        // Narrow type without importing HttpException explicitly to avoid circular deps
        const httpEx = exception as {
          getStatus: () => number;
          getResponse: () => unknown;
          message: string;
        };
        statusCode = httpEx.getStatus();
        const resp = httpEx.getResponse();
        message = typeof resp === 'string' ? resp : httpEx.message;
      } catch {
        // fall through
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    // Log with safe context
    const looksLikeNotFound =
      statusCode === 404 ||
      /not\s*found/i.test(String(message)) ||
      /not\s*found/i.test(String((details as Record<string, unknown> | undefined)?.message ?? ''));

    const wsLogPayload = {
      code,
      statusCode,
      message,
      data,
      // WS logs are often noisy; keep stack only for server-side faults
      stack: statusCode >= 500 && exception instanceof Error ? exception.stack : undefined,
    } as const;

    if (looksLikeNotFound) {
      logger.info(wsLogPayload, 'WS not found');
    } else if (statusCode >= 400 && statusCode < 500) {
      logger.warn(wsLogPayload, 'WS client error');
    } else {
      logger.error(wsLogPayload, 'WS handler failed');
    }

    // Build envelope compatible with TerminalGateway consumers
    const envelope = {
      topic: 'system',
      type: 'error',
      payload: {
        code,
        message,
        statusCode,
        details,
      },
      ts: new Date().toISOString(),
    };

    try {
      client.emit('message', envelope);
    } catch (emitError) {
      logger.warn({ emitError }, 'Failed to emit WS error envelope');
    }
  }
}
