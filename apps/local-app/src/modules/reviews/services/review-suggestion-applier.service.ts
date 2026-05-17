import { Injectable, Inject, Logger } from '@nestjs/common';
import { readFile, writeFile } from 'fs/promises';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type { ReviewComment } from '../../storage/models/domain.models';
import { ReviewsService } from './reviews.service';
import { ValidationError } from '../../../common/errors/error-types';
import {
  validatePathWithinRoot,
  validateResolvedPathWithinRoot,
  validateLineBounds,
} from '../../../common/validation/path-validation';

export type SuggestionErrorCode =
  | 'COMMENT_NOT_IN_PROJECT'
  | 'INVALID_SUGGESTION'
  | 'NO_SUGGESTION'
  | 'PATH_TRAVERSAL_BLOCKED'
  | 'SYMLINK_ESCAPE_BLOCKED'
  | 'INVALID_LINE_BOUNDS'
  | 'VERSION_CONFLICT';

export class SuggestionApplicationError extends Error {
  constructor(
    public readonly code: SuggestionErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SuggestionApplicationError';
  }
}

export interface ApplySuggestionInput {
  commentId: string;
  projectId: string;
  projectRootPath: string;
  version: number;
}

export interface ApplySuggestionResult {
  updatedComment: ReviewComment;
  filePath: string;
  suggestedCode: string;
  lineStart: number;
  lineEnd: number;
}

@Injectable()
export class ReviewSuggestionApplier {
  private readonly logger = new Logger(ReviewSuggestionApplier.name);

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly reviewsService: ReviewsService,
  ) {}

  async apply(input: ApplySuggestionInput): Promise<ApplySuggestionResult> {
    const comment = await this.storage.getReviewComment(input.commentId);
    const review = await this.storage.getReview(comment.reviewId);

    if (review.projectId !== input.projectId) {
      throw new SuggestionApplicationError(
        'COMMENT_NOT_IN_PROJECT',
        `Comment ${input.commentId} does not belong to this project`,
      );
    }

    if (!comment.filePath || comment.lineStart === null) {
      throw new SuggestionApplicationError(
        'INVALID_SUGGESTION',
        'Comment does not have file path or line information',
      );
    }

    const suggestionMatch = comment.content.match(/```suggestion\s*\n([\s\S]*?)```/);
    if (!suggestionMatch) {
      throw new SuggestionApplicationError(
        'NO_SUGGESTION',
        'Comment does not contain a suggestion block',
      );
    }

    const suggestedCode = suggestionMatch[1].trimEnd();
    const lineStart = comment.lineStart;
    const lineEnd = comment.lineEnd ?? comment.lineStart;

    let absolutePath: string;
    try {
      const validatedPath = validatePathWithinRoot(input.projectRootPath, comment.filePath, {
        errorPrefix: 'Invalid file path in comment',
      });
      absolutePath = validatedPath.absolutePath;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw new SuggestionApplicationError(
          'PATH_TRAVERSAL_BLOCKED',
          error.message,
          error.details,
        );
      }
      throw error;
    }

    let realFilePath: string;
    try {
      realFilePath = await validateResolvedPathWithinRoot(absolutePath, input.projectRootPath, {
        errorPrefix: 'Symlink validation failed',
      });
    } catch (error) {
      if (error instanceof ValidationError) {
        throw new SuggestionApplicationError(
          'SYMLINK_ESCAPE_BLOCKED',
          error.message,
          error.details,
        );
      }
      throw error;
    }

    const fileContent = await readFile(realFilePath, 'utf-8');
    const lines = fileContent.split('\n');

    try {
      validateLineBounds(lineStart, lineEnd, lines.length);
    } catch (error) {
      if (error instanceof ValidationError) {
        throw new SuggestionApplicationError('INVALID_LINE_BOUNDS', error.message, error.details);
      }
      throw error;
    }

    if (comment.version !== input.version) {
      throw new SuggestionApplicationError(
        'VERSION_CONFLICT',
        `Comment version mismatch: expected ${input.version}, current ${comment.version}.`,
        {
          commentId: input.commentId,
          expectedVersion: input.version,
          currentVersion: comment.version,
        },
      );
    }

    const suggestedLines = suggestedCode.split('\n');
    lines.splice(lineStart - 1, lineEnd - lineStart + 1, ...suggestedLines);

    await writeFile(realFilePath, lines.join('\n'), 'utf-8');

    const updatedComment = await this.reviewsService.resolveComment(
      comment.reviewId,
      input.commentId,
      'resolved',
      input.version,
    );

    return {
      updatedComment,
      filePath: comment.filePath,
      suggestedCode,
      lineStart,
      lineEnd,
    };
  }
}
