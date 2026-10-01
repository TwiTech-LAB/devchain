import { Injectable, StreamableFile } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { map } from 'rxjs/operators';
import { transcriptJsonStream } from '../services/transcript-json-stream';

@Injectable()
export class TranscriptJsonInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(
      map(
        (body: unknown) =>
          new StreamableFile(transcriptJsonStream(body), {
            type: 'application/json; charset=utf-8',
          }),
      ),
    );
  }
}
