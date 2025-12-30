import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { AppError } from '../errors/error-types';
import { createLogger } from '../logging/logger';
import { ZodError } from 'zod';

const logger = createLogger('HttpExceptionFilter');

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let code = 'internal_error';
    let details: unknown;

    if (exception instanceof AppError) {
      status = exception.statusCode;
      message = exception.message;
      code = exception.code;
      details = exception.details;
    } else if (exception instanceof ZodError) {
      status = HttpStatus.BAD_REQUEST;
      message = 'Bad Request';
      code = 'validation_error';
      details = exception.errors;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else {
        details = exceptionResponse;
        const responseMessage = (exceptionResponse as { message?: unknown } | null | undefined)
          ?.message;
        if (typeof responseMessage === 'string') {
          message = responseMessage;
        } else if (Array.isArray(responseMessage)) {
          message = 'Bad Request';
        } else {
          message = exception.message;
        }
      }
      code = 'http_exception';
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    // Downgrade noisy, expected statuses to avoid scary logs on normal flows
    const isClientError = status >= 400 && status < 500;
    const isNotFound = status === 404;
    const logPayload = {
      requestId: request.id,
      method: request.method,
      url: request.url,
      statusCode: status,
      code,
      message,
      // Only include stack traces for server errors
      stack: !isClientError && exception instanceof Error ? exception.stack : undefined,
    } as const;

    if (isNotFound) {
      logger.info(logPayload, 'Request not found');
    } else if (isClientError) {
      logger.warn(logPayload, 'Client error');
    } else {
      logger.error(logPayload, 'Request failed');
    }

    // Guard against double-send (can happen if response was partially sent)
    if (response.sent) {
      return;
    }

    // Fastify uses .code() instead of .status() for setting status code
    response.code(status).send({
      statusCode: status,
      code,
      message,
      details,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
